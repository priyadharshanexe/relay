"""Housekeeping that runs beside delivery, in every worker process.

Each tick (every ``maintenance_interval_seconds``):

1. **Retention:** delete finished events older than ``retention_days``.
2. **Demo reset** (only when ``demo_mode`` is on): once a day, wipe all data and
   seed the demo again. Between resets, if the demo account has gone missing,
   seed it back.

Every step is safe with several workers running it at once: retention takes
disjoint rows (SKIP LOCKED), the reset is guarded by a locked row, and seeding
by an advisory lock. A failing step is logged and retried next tick; it never
stops deliveries.
"""

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from relay.core.config import Settings
from relay.core.crypto import SecretBox
from relay.core.logging import get_logger
from relay.services import demo, retention
from relay.worker.loop import Worker

log = get_logger("relay.maintenance")


def utc_now() -> datetime:
    return datetime.now(UTC)


class MaintenanceWorker(Worker):
    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        settings: Settings,
        box: SecretBox,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        super().__init__(poll_interval=settings.maintenance_interval_seconds)
        self._sessions = sessions
        self._settings = settings
        self._box = box
        self._clock = clock

    async def tick(self) -> bool:
        now = self._clock()
        await self._run("retention", self._retention(now))
        if self._settings.demo_mode:
            await self._run("demo", self._demo(now))
        return False  # always wait for the next interval

    async def _run(self, step: str, work: Awaitable[None]) -> None:
        try:
            await work
        except Exception:
            log.exception("maintenance.step_failed", step=step)

    async def _retention(self, now: datetime) -> None:
        await retention.purge_old_events(
            self._sessions,
            cutoff=now - timedelta(days=self._settings.retention_days),
            batch_size=self._settings.retention_batch_size,
        )

    async def _demo(self, now: datetime) -> None:
        reset = await demo.reset_demo_if_due(
            self._sessions, settings=self._settings, box=self._box, now=now
        )
        if reset:
            return
        async with self._sessions() as session:
            exists = await demo.demo_account_exists(session, self._settings)
        if not exists:
            await demo.seed_demo(self._sessions, settings=self._settings, box=self._box, now=now)
