"""The worker's main loop and lifecycle.

Each iteration ("tick") does one batch of work; between ticks the worker sleeps
for ``poll_interval`` seconds, unless the last tick found a full batch, in which
case it goes straight to the next one.

``request_stop()`` is called from a SIGTERM/SIGINT handler. The worker stops
taking new work, lets the current tick finish (every delivery in it is sent and
recorded), then returns from ``run()``. Nothing is cut off half-way, which is what
makes ``docker stop`` and deploys safe.
"""

import asyncio
import contextlib
import os
import signal
import socket
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from relay.core.logging import get_logger
from relay.worker.claim import claim_due, sweep_expired

log = get_logger("relay.worker")


def new_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


class Worker:
    def __init__(self, *, poll_interval: float) -> None:
        self.worker_id = new_worker_id()
        self._poll_interval = poll_interval
        self._stop = asyncio.Event()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def request_stop(self) -> None:
        if not self._stop.is_set():
            log.info("worker.stop_requested", worker_id=self.worker_id)
            self._stop.set()

    async def run(self) -> None:
        log.info("worker.started", worker_id=self.worker_id, poll_interval=self._poll_interval)
        try:
            while not self._stop.is_set():
                more_work_waiting = await self.tick()
                if not more_work_waiting:
                    await self._sleep_until_next_tick()
        finally:
            log.info("worker.stopped", worker_id=self.worker_id)

    async def tick(self) -> bool | None:
        """One unit of work. Return True to skip the sleep and tick again at once."""
        return None

    async def _sleep_until_next_tick(self) -> None:
        # Wakes immediately when a stop is requested instead of finishing the sleep.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=self._poll_interval)


class DeliveryWorker(Worker):
    """Claims due deliveries and processes them concurrently."""

    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        process: Callable[[uuid.UUID], Awaitable[None]],
        poll_interval: float,
        batch_size: int,
        concurrency: int,
        lock_seconds: int,
        worker_id: str | None = None,
    ) -> None:
        super().__init__(poll_interval=poll_interval)
        if worker_id is not None:
            self.worker_id = worker_id
        self._sessions = sessions
        self._process = process
        self._batch_size = batch_size
        self._lock_seconds = lock_seconds
        self._slots = asyncio.Semaphore(concurrency)

    async def tick(self) -> bool:
        try:
            recovered = await sweep_expired(self._sessions)
            if recovered:
                log.warning("worker.recovered_expired_leases", count=len(recovered))
            claimed = await claim_due(
                self._sessions,
                worker_id=self.worker_id,
                limit=self._batch_size,
                lock_seconds=self._lock_seconds,
            )
        except Exception:
            # The database being briefly unavailable must not kill the worker.
            log.exception("worker.claim_failed")
            return False

        await asyncio.gather(*(self._process_one(delivery_id) for delivery_id in claimed))
        return len(claimed) == self._batch_size

    async def _process_one(self, delivery_id: uuid.UUID) -> None:
        async with self._slots:
            try:
                await self._process(delivery_id)
            except Exception:
                # One bad delivery must not take the batch down. It stays
                # in_flight; once its lease expires the sweeper re-queues it.
                log.exception("worker.delivery_crashed", delivery_id=str(delivery_id))


def install_signal_handlers(on_stop: Callable[[], None]) -> None:
    """Call ``on_stop`` on SIGTERM (docker stop) and SIGINT (Ctrl+C)."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, on_stop)
        except NotImplementedError:
            # Windows event loops don't support add_signal_handler; fall back to
            # signal.signal and hop back onto the loop thread safely.
            signal.signal(sig, lambda _signum, _frame: loop.call_soon_threadsafe(on_stop))
