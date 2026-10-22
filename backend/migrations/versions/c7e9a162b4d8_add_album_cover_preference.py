"""Add an optional album cover preference without rewriting existing data."""

import sqlalchemy as sa
from alembic import op

revision = "c7e9a162b4d8"
down_revision = "b61e24f803a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Membership and active-state checks live in album_query; a nullable hint
    # must not prevent deleting a photo or moving it to a different album.
    op.add_column("albums", sa.Column("preferred_cover_photo_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("albums", "preferred_cover_photo_id")
