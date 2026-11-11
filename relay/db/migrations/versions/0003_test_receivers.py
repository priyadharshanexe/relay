"""test receivers

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-11 22:49:07.450092
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "test_receivers",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("mode", sa.String(length=20), server_default="ok", nullable=False),
        sa.Column("status_code", sa.Integer(), server_default="500", nullable=False),
        sa.Column("delay_ms", sa.Integer(), server_default="2000", nullable=False),
        sa.Column("retry_after_seconds", sa.Integer(), server_default="30", nullable=False),
        sa.Column("requests_received", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "mode IN ('ok', 'error', 'rate_limit', 'slow', 'timeout')",
            name=op.f("ck_test_receivers_mode_valid"),
        ),
        sa.CheckConstraint(
            "delay_ms BETWEEN 0 AND 30000", name=op.f("ck_test_receivers_delay_bounded")
        ),
        sa.CheckConstraint(
            "retry_after_seconds BETWEEN 0 AND 86400",
            name=op.f("ck_test_receivers_retry_after_bounded"),
        ),
        sa.CheckConstraint(
            "status_code BETWEEN 400 AND 599",
            name=op.f("ck_test_receivers_status_code_is_an_error"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_test_receivers_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_test_receivers")),
        sa.UniqueConstraint("token", name=op.f("uq_test_receivers_token")),
    )
    op.create_index(op.f("ix_test_receivers_org_id"), "test_receivers", ["org_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_test_receivers_org_id"), table_name="test_receivers")
    op.drop_table("test_receivers")
