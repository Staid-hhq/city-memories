"""Seed the three reviewed T03 business city mappings (no geometry or credentials)."""

import sqlalchemy as sa
from alembic import op

revision = "b61e24f803a7"
down_revision = "4a097ff7fccb"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Stable application UUIDs never depend on a provider's administrative code.
    # Evidence and limited coverage: docs/t03-city-mappings.md.
    cities = sa.table(
        "cities",
        *[
            sa.column(name, sa.Text)
            for name in (
                "id",
                "provider",
                "provider_code",
                "name",
                "parent_name",
                "unit_kind",
                "mapping_status",
            )
        ],
        sa.column("is_active", sa.Integer),
    )
    op.bulk_insert(
        cities,
        [
            dict(
                id=identifier,
                provider="tianditu",
                provider_code=code,
                name=name,
                parent_name=parent,
                unit_kind="prefecture",
                mapping_status="verified",
                is_active=1,
            )
            for identifier, code, name, parent in (
                ("a03b8f10-06dd-4b56-aef1-33cfc3696301", "156440300", "深圳市", "广东省"),
                ("a03b8f10-06dd-4b56-aef1-33cfc3696302", "156440100", "广州市", "广东省"),
                ("a03b8f10-06dd-4b56-aef1-33cfc3696303", "156451100", "贺州市", "广西壮族自治区"),
            )
        ],
    )


def downgrade() -> None:
    # Do not cascade/delete private albums. An occupied mapping blocks downgrade.
    op.execute(
        sa.text("DELETE FROM cities WHERE id IN (:a, :b, :c)").bindparams(
            a="a03b8f10-06dd-4b56-aef1-33cfc3696301",
            b="a03b8f10-06dd-4b56-aef1-33cfc3696302",
            c="a03b8f10-06dd-4b56-aef1-33cfc3696303",
        )
    )
