import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


async def test_readyz_is_ok_when_postgres_and_redis_answer(client: AsyncClient) -> None:
    response = await client.get("/readyz")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "ok",
        "checks": {"database": "ok", "redis": "ok"},
    }
