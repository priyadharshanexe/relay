from httpx import ASGITransport, AsyncClient

from relay.main import create_app
from tests.conftest import make_settings

# Port 1 on loopback: nothing listens there, so connections are refused.
UNREACHABLE_DATABASE = "postgresql+asyncpg://relay:relay@127.0.0.1:1/relay"
UNREACHABLE_REDIS = "redis://127.0.0.1:1/0"


async def test_healthz_does_not_depend_on_anything(client: AsyncClient) -> None:
    response = await client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readyz_is_503_and_names_the_failed_dependencies() -> None:
    app = create_app(make_settings(database_url=UNREACHABLE_DATABASE, redis_url=UNREACHABLE_REDIS))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/readyz")

    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {"database": "unavailable", "redis": "unavailable"},
    }
