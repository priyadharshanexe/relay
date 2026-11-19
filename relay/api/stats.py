"""Activity numbers for the dashboard's overview page."""

import uuid
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel, Field

from relay.api.deps import OrgDep, SessionDep, utc_now
from relay.services import stats as stats_service

router = APIRouter(prefix="/stats", tags=["stats"])


class BucketOut(BaseModel):
    start: datetime = Field(description="Start of the hour this bucket covers.")
    succeeded: int = Field(description="Attempts that were accepted (2xx).")
    failed: int = Field(description="Attempts that failed, for any reason.")
    p95_ms: int | None = Field(description="95th-percentile attempt duration; null when idle.")


class EndpointSeriesOut(BaseModel):
    endpoint_id: uuid.UUID
    succeeded: list[int] = Field(description="One value per bucket, oldest first.")
    failed: list[int]


class OverviewOut(BaseModel):
    since: datetime
    buckets: list[BucketOut] = Field(description="24 hourly buckets, oldest first.")
    endpoints: list[EndpointSeriesOut] = Field(
        description="Per endpoint, the same buckets. Endpoints with no attempts are left out."
    )
    deliveries_by_status: dict[str, int] = Field(
        description="How many deliveries are in each state right now (all time)."
    )
    events: int = Field(description="Events received in the window.")
    attempts: int
    successes: int
    success_rate: float | None = Field(description="0 to 1; null when there were no attempts.")
    p95_ms: int | None


@router.get("/overview")
async def overview(context: OrgDep, session: SessionDep) -> OverviewOut:
    """Delivery activity over the last 24 hours, hour by hour."""
    data = await stats_service.overview(session, context.org_id, now=utc_now())
    return OverviewOut(
        since=data.since,
        buckets=[
            BucketOut(start=b.start, succeeded=b.succeeded, failed=b.failed, p95_ms=b.p95_ms)
            for b in data.buckets
        ],
        endpoints=[
            EndpointSeriesOut(endpoint_id=e.endpoint_id, succeeded=e.succeeded, failed=e.failed)
            for e in data.endpoints
        ],
        deliveries_by_status=data.deliveries_by_status,
        events=data.events,
        attempts=data.attempts,
        successes=data.successes,
        success_rate=data.successes / data.attempts if data.attempts else None,
        p95_ms=data.p95_ms,
    )
