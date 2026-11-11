"""Run database migrations: ``python -m relay.db.migrate [upgrade|downgrade|current] [revision]``.

The migration scripts ship inside the ``relay`` package, so this works in the
production image, where there is no ``alembic.ini``.
"""

import argparse

from alembic import command
from alembic.config import Config

from relay.core.config import get_settings
from relay.core.logging import configure_logging, get_logger

log = get_logger("relay.migrate")


def alembic_config(database_url: str | None = None) -> Config:
    config = Config()
    # "package:folder" form: resolved from the installed package, not the working directory.
    config.set_main_option("script_location", "relay.db:migrations")
    if database_url is not None:
        # Alembic's config uses %-interpolation, so a literal % must be doubled.
        config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return config


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m relay.db.migrate")
    parser.add_argument(
        "action", nargs="?", default="upgrade", choices=["upgrade", "downgrade", "current"]
    )
    parser.add_argument("revision", nargs="?", default=None)
    args = parser.parse_args(argv)

    settings = get_settings()
    configure_logging(settings.log_level, json=settings.log_json)
    config = alembic_config()

    if args.action == "upgrade":
        revision = args.revision or "head"
        command.upgrade(config, revision)
        log.info("migrate.upgraded", revision=revision)
    elif args.action == "downgrade":
        if args.revision is None:
            parser.error("downgrade needs a target revision, e.g. 'downgrade -1'")
        command.downgrade(config, args.revision)
        log.info("migrate.downgraded", revision=args.revision)
    else:
        command.current(config, verbose=True)


if __name__ == "__main__":
    main()
