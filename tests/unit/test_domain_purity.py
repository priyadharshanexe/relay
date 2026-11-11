"""Architecture rule: ``relay.domain`` is pure.

It may not import web, database, cache or network libraries, nor any other part of
the application. That keeps the business rules testable in microseconds and stops
infrastructure concerns leaking into them. This test enforces the rule.
"""

import ast
from pathlib import Path

import relay.domain

DOMAIN_DIR = Path(relay.domain.__file__).parent

FORBIDDEN_LIBRARIES = {
    "fastapi",
    "starlette",
    "sqlalchemy",
    "alembic",
    "asyncpg",
    "redis",
    "httpx",
    "socket",
    "ssl",
    "asyncio",
}


def imported_modules(path: Path) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def test_domain_imports_no_infrastructure() -> None:
    files = sorted(DOMAIN_DIR.glob("*.py"))
    assert len(files) >= 6, "expected the domain modules to be found"

    for path in files:
        for module in imported_modules(path):
            top_level = module.split(".")[0]
            assert top_level not in FORBIDDEN_LIBRARIES, f"{path.name} imports {module}"
            if top_level == "relay":
                assert module.startswith("relay.domain"), f"{path.name} imports {module}"
