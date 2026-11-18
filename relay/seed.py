"""Create the demo organisation: ``python -m relay.seed``.

Safe to run any number of times: what already exists is left alone, and what is
missing is created. Prints what it did, never a secret. The demo account's
password is RELAY_DEMO_PASSWORD; it is not printed either.
"""

import asyncio
from datetime import UTC, datetime

from relay.core.config import Settings, get_settings
from relay.core.crypto import SecretBox
from relay.core.logging import configure_logging
from relay.db.session import create_engine, create_session_factory
from relay.services.demo import SeedSummary, seed_demo


def describe(summary: SeedSummary, settings: Settings) -> str:
    if not summary.changed_anything:
        headline = "The demo organisation was already there; nothing to do."
    else:
        headline = (
            "Demo organisation ready: "
            f"{'a new account, ' if summary.created_account else ''}"
            f"{summary.receivers_created} test receiver(s), "
            f"{summary.endpoints_created} endpoint(s) and "
            f"{summary.events_created} sample event(s) created."
        )
    return "\n".join(
        [
            headline,
            f"  Organisation: {settings.demo_organization_name}",
            f"  Log in as:    {summary.email}",
            "  Password:     the value of RELAY_DEMO_PASSWORD (not printed)",
            f"  API key:      {summary.api_key_prefix}… (create your own in the dashboard;"
            " full keys are only ever shown once)",
        ]
    )


async def _main(settings: Settings) -> SeedSummary:
    engine = create_engine(settings, application_name="relay-seed")
    try:
        return await seed_demo(
            create_session_factory(engine),
            settings=settings,
            box=SecretBox(settings.encryption_key.get_secret_value()),
            now=datetime.now(UTC),
        )
    finally:
        await engine.dispose()


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.log_json)
    summary = asyncio.run(_main(settings))
    print(describe(summary, settings))


if __name__ == "__main__":
    main()
