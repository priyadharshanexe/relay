"""Entry point: ``python -m relay.worker``."""

import asyncio

from relay.core.config import get_settings
from relay.core.logging import configure_logging
from relay.worker.loop import Worker, install_signal_handlers


async def _main() -> None:
    settings = get_settings()
    worker = Worker(poll_interval=settings.worker_poll_interval_seconds)
    install_signal_handlers(worker.request_stop)
    await worker.run()


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.log_json)
    asyncio.run(_main())


if __name__ == "__main__":
    main()
