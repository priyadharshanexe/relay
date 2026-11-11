"""initial schema

Revision ID: 0001
Revises: -
Create Date: 2026-11-11 16:14:57.341537
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_organizations")),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("email = lower(email)", name=op.f("ck_users_email_lowercase")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
    )
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("prefix", sa.String(length=32), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_api_keys_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_api_keys")),
        sa.UniqueConstraint("key_hash", name=op.f("uq_api_keys_key_hash")),
        sa.UniqueConstraint("prefix", name=op.f("uq_api_keys_prefix")),
    )
    op.create_index(op.f("ix_api_keys_org_id"), "api_keys", ["org_id"], unique=False)
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", sa.String(length=100), nullable=False),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "details", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_audit_log_actor_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_audit_log_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_log")),
    )
    op.create_index(
        "ix_audit_log_org_id_at",
        "audit_log",
        ["org_id", sa.literal_column("at DESC")],
        unique=False,
    )
    op.create_table(
        "endpoints",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("description", sa.String(length=500), server_default="", nullable=False),
        sa.Column(
            "event_types",
            postgresql.ARRAY(sa.String(length=200)),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("status", sa.String(length=20), server_default="active", nullable=False),
        sa.Column("rate_limit_per_sec", sa.Integer(), nullable=True),
        sa.Column("breaker_state", sa.String(length=20), server_default="closed", nullable=False),
        sa.Column("consecutive_failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("breaker_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "breaker_state IN ('closed', 'open', 'half_open')",
            name=op.f("ck_endpoints_breaker_state_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('active', 'paused', 'disabled')", name=op.f("ck_endpoints_status_valid")
        ),
        sa.CheckConstraint("char_length(url) <= 2048", name=op.f("ck_endpoints_url_length")),
        sa.CheckConstraint(
            "consecutive_failures >= 0", name=op.f("ck_endpoints_consecutive_failures_non_negative")
        ),
        sa.CheckConstraint(
            "rate_limit_per_sec IS NULL OR rate_limit_per_sec > 0",
            name=op.f("ck_endpoints_rate_limit_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_endpoints_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_endpoints")),
    )
    op.create_index(op.f("ix_endpoints_org_id"), "endpoints", ["org_id"], unique=False)
    op.create_table(
        "events",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(length=200), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_events_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_events")),
        sa.UniqueConstraint("org_id", "idempotency_key", name="uq_events_org_id_idempotency_key"),
    )
    op.create_index(
        "ix_events_org_id_created_at",
        "events",
        ["org_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "memberships",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'developer', 'viewer')", name=op.f("ck_memberships_role_valid")
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_memberships_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_memberships_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("user_id", "org_id", name=op.f("pk_memberships")),
    )
    op.create_index("ix_memberships_org_id", "memberships", ["org_id"], unique=False)
    op.create_table(
        "deliveries",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("endpoint_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_by", sa.String(length=200), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'in_flight', 'retrying', 'succeeded', 'dead')",
            name=op.f("ck_deliveries_status_valid"),
        ),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_deliveries_attempts_non_negative")),
        sa.ForeignKeyConstraint(
            ["endpoint_id"],
            ["endpoints.id"],
            name=op.f("fk_deliveries_endpoint_id_endpoints"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_deliveries_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_deliveries_org_id_organizations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deliveries")),
        sa.UniqueConstraint("event_id", "endpoint_id", name="uq_deliveries_event_id_endpoint_id"),
    )
    op.create_index(
        "deliveries_due",
        "deliveries",
        ["next_attempt_at"],
        unique=False,
        postgresql_where=sa.text("status IN ('pending', 'retrying')"),
    )
    op.create_index(
        "deliveries_expired_locks",
        "deliveries",
        ["locked_until"],
        unique=False,
        postgresql_where=sa.text("status = 'in_flight'"),
    )
    op.create_index(
        "ix_deliveries_endpoint_id_created_at",
        "deliveries",
        ["endpoint_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_deliveries_org_id_created_at",
        "deliveries",
        ["org_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "endpoint_secrets",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("endpoint_id", sa.Uuid(), nullable=False),
        sa.Column("secret_encrypted", sa.Text(), nullable=False),
        sa.Column(
            "active_from",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["endpoint_id"],
            ["endpoints.id"],
            name=op.f("fk_endpoint_secrets_endpoint_id_endpoints"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_endpoint_secrets")),
    )
    op.create_index(
        op.f("ix_endpoint_secrets_endpoint_id"), "endpoint_secrets", ["endpoint_id"], unique=False
    )
    op.create_table(
        "attempts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("delivery_id", sa.Uuid(), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("error_kind", sa.String(length=20), nullable=True),
        sa.Column("response_snippet", sa.Text(), nullable=True),
        sa.Column(
            "request_headers",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("response_headers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.CheckConstraint(
            "error_kind IS NULL OR error_kind IN ('timeout', 'dns', 'tls', 'connect', 'http_status', 'ssrf_blocked', 'other')",
            name=op.f("ck_attempts_error_kind_valid"),
        ),
        sa.CheckConstraint("attempt_number >= 1", name=op.f("ck_attempts_attempt_number_positive")),
        sa.CheckConstraint("duration_ms >= 0", name=op.f("ck_attempts_duration_non_negative")),
        sa.ForeignKeyConstraint(
            ["delivery_id"],
            ["deliveries.id"],
            name=op.f("fk_attempts_delivery_id_deliveries"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_attempts")),
    )
    op.create_index(
        "ix_attempts_delivery_id_started_at",
        "attempts",
        ["delivery_id", "started_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_attempts_delivery_id_started_at", table_name="attempts")
    op.drop_table("attempts")
    op.drop_index(op.f("ix_endpoint_secrets_endpoint_id"), table_name="endpoint_secrets")
    op.drop_table("endpoint_secrets")
    op.drop_index("ix_deliveries_org_id_created_at", table_name="deliveries")
    op.drop_index("ix_deliveries_endpoint_id_created_at", table_name="deliveries")
    op.drop_index(
        "deliveries_expired_locks",
        table_name="deliveries",
        postgresql_where=sa.text("status = 'in_flight'"),
    )
    op.drop_index(
        "deliveries_due",
        table_name="deliveries",
        postgresql_where=sa.text("status IN ('pending', 'retrying')"),
    )
    op.drop_table("deliveries")
    op.drop_index("ix_memberships_org_id", table_name="memberships")
    op.drop_table("memberships")
    op.drop_index("ix_events_org_id_created_at", table_name="events")
    op.drop_table("events")
    op.drop_index(op.f("ix_endpoints_org_id"), table_name="endpoints")
    op.drop_table("endpoints")
    op.drop_index("ix_audit_log_org_id_at", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_index(op.f("ix_api_keys_org_id"), table_name="api_keys")
    op.drop_table("api_keys")
    op.drop_table("users")
    op.drop_table("organizations")
