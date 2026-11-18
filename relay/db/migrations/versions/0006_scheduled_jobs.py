"""scheduled jobs

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-18 13:41:30.586956
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scheduled_jobs",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("name", name=op.f("pk_scheduled_jobs")),
    )


def downgrade() -> None:
    op.drop_table("scheduled_jobs")
