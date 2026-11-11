"""The delivery worker's main loop.

Each iteration ("tick") claims due deliveries and sends them; between ticks the
worker sleeps for ``poll_interval`` seconds. The claim/deliver logic arrives with
the delivery pipeline; this module owns the lifecycle around it:

* ``request_stop()`` - called from a SIGTERM/SIGINT handler. The worker stops
  claiming new work, lets the current tick finish, then returns from ``run()``.
  Nothing is cut off half-way, which is what makes ``docker stop`` safe.
"""

import asyncio
import contextlib
import os
import signal
import socket
from collections.abc import Callable

from relay.core.logging import get_logger

log = get_logger("relay.worker")


class Worker:
    def __init__(self, *, poll_interval: float) -> None:
        self.worker_id = f"{socket.gethostname()}-{os.getpid()}"
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
                await self.tick()
                await self._sleep_until_next_tick()
        finally:
            log.info("worker.stopped", worker_id=self.worker_id)

    async def tick(self) -> None:
        """One unit of work. Claiming and delivering are added in the delivery phase."""

    async def _sleep_until_next_tick(self) -> None:
        # Wakes immediately when a stop is requested instead of finishing the sleep.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=self._poll_interval)


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
