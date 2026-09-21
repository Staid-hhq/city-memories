from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("username_key"), {"sqlite_strict": True})

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    username: Mapped[str] = mapped_column(Text)
    username_key: Mapped[str] = mapped_column(Text)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[int] = mapped_column(Integer)


class LoginSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("expires_at > created_at", name="expiry_after_creation"),
        Index("ix_sessions_user", "user_id"),
        Index("ix_sessions_expiry", "expires_at"),
        {"sqlite_strict": True},
    )

    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str | None] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="RESTRICT"),
    )
    csrf_token: Mapped[str] = mapped_column(Text)
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    last_seen_at: Mapped[int] = mapped_column(Integer)
    revoked_at: Mapped[int | None] = mapped_column(Integer)


class AuthRateLimit(Base):
    __tablename__ = "auth_rate_limits"
    __table_args__ = (
        CheckConstraint("attempts >= 0", name="attempts_nonnegative"),
        Index("ix_auth_rate_limits_expiry", "expires_at"),
        {"sqlite_strict": True},
    )

    scope: Mapped[str] = mapped_column(Text, primary_key=True)
    key_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    window_start: Mapped[int] = mapped_column(Integer, primary_key=True)
    attempts: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)


class City(Base):
    __tablename__ = "cities"
    __table_args__ = (
        CheckConstraint("mapping_status IN ('pending', 'verified')", name="mapping_status"),
        CheckConstraint("is_active IN (0, 1)", name="active_flag"),
        UniqueConstraint("provider", "provider_code"),
        {"sqlite_strict": True},
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    provider: Mapped[str] = mapped_column(Text)
    provider_code: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    parent_name: Mapped[str | None] = mapped_column(Text)
    unit_kind: Mapped[str] = mapped_column(Text)
    mapping_status: Mapped[str] = mapped_column(Text)
    is_active: Mapped[int] = mapped_column(Integer, default=1, server_default="1")


class Album(Base):
    __tablename__ = "albums"
    __table_args__ = (
        CheckConstraint("year IS NULL OR year BETWEEN 1 AND 9999", name="valid_year"),
        CheckConstraint("revision >= 1", name="revision_positive"),
        UniqueConstraint("id", "owner_id"),
        {"sqlite_strict": True},
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id", ondelete="RESTRICT"))
    city_id: Mapped[str] = mapped_column(Text, ForeignKey("cities.id", ondelete="RESTRICT"))
    year: Mapped[int | None] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)


Index(
    "uq_albums_year",
    Album.owner_id,
    Album.city_id,
    Album.year,
    unique=True,
    sqlite_where=Album.year.is_not(None),
)
Index(
    "uq_albums_unmarked",
    Album.owner_id,
    Album.city_id,
    unique=True,
    sqlite_where=Album.year.is_(None),
)


class ImportBatch(Base):
    __tablename__ = "import_batches"
    __table_args__ = (
        CheckConstraint("length(request_hash) = 64", name="request_hash_length"),
        CheckConstraint("expected_count > 0", name="expected_count_positive"),
        CheckConstraint(
            "state IN ('open', 'committed', 'canceled', 'expired')",
            name="valid_state",
        ),
        CheckConstraint("expires_at > created_at", name="expiry_after_creation"),
        CheckConstraint(
            "(state = 'committed' AND committed_at IS NOT NULL "
            "AND commit_request_hash IS NOT NULL AND commit_result_json IS NOT NULL) "
            "OR (state <> 'committed' AND committed_at IS NULL "
            "AND commit_request_hash IS NULL AND commit_result_json IS NULL)",
            name="commit_receipt_matches_state",
        ),
        UniqueConstraint("id", "owner_id"),
        UniqueConstraint("owner_id", "request_key"),
        ForeignKeyConstraint(
            ["album_id", "owner_id"],
            ["albums.id", "albums.owner_id"],
            ondelete="RESTRICT",
        ),
        Index("ix_import_batches_album", "album_id", "owner_id"),
        Index("ix_import_batches_expiry", "state", "expires_at"),
        {"sqlite_strict": True},
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text)
    album_id: Mapped[str] = mapped_column(Text)
    request_key: Mapped[str] = mapped_column(Text)
    request_hash: Mapped[str] = mapped_column(Text)
    expected_count: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(Text, default="open", server_default="open")
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    committed_at: Mapped[int | None] = mapped_column(Integer)
    commit_request_hash: Mapped[str | None] = mapped_column(Text)
    commit_result_json: Mapped[str | None] = mapped_column(Text)


class UploadItem(Base):
    __tablename__ = "upload_items"
    __table_args__ = (
        CheckConstraint("item_index >= 0", name="item_index_nonnegative"),
        CheckConstraint("expected_bytes > 0", name="expected_bytes_positive"),
        CheckConstraint("length(expected_sha256) = 64", name="expected_hash_length"),
        CheckConstraint(
            "state IN ('pending', 'receiving', 'staged', 'failed', 'committed', 'discarded')",
            name="valid_state",
        ),
        CheckConstraint(
            "(state = 'receiving' AND attempt_token IS NOT NULL AND lease_until IS NOT NULL) "
            "OR (state <> 'receiving' AND attempt_token IS NULL AND lease_until IS NULL)",
            name="receiving_has_lease",
        ),
        CheckConstraint(
            "state NOT IN ('staged', 'committed') OR ("
            "actual_bytes IS NOT NULL AND actual_bytes = expected_bytes "
            "AND sha256 IS NOT NULL AND sha256 = expected_sha256 "
            "AND mime_type IS NOT NULL AND mime_type IN ('image/jpeg', 'image/png', 'image/webp') "
            "AND width IS NOT NULL AND width > 0 AND height IS NOT NULL AND height > 0)",
            name="staged_file_metadata_complete",
        ),
        UniqueConstraint("storage_key"),
        UniqueConstraint("reserved_photo_id"),
        UniqueConstraint("batch_id", "item_index"),
        UniqueConstraint("id", "owner_id"),
        ForeignKeyConstraint(
            ["batch_id", "owner_id"],
            ["import_batches.id", "import_batches.owner_id"],
            ondelete="RESTRICT",
        ),
        {"sqlite_strict": True},
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text)
    batch_id: Mapped[str] = mapped_column(Text)
    item_index: Mapped[int] = mapped_column(Integer)
    original_filename: Mapped[str] = mapped_column(Text)
    expected_bytes: Mapped[int] = mapped_column(Integer)
    expected_sha256: Mapped[str] = mapped_column(Text)
    storage_key: Mapped[str] = mapped_column(Text)
    reserved_photo_id: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    attempt_token: Mapped[str | None] = mapped_column(Text)
    lease_until: Mapped[int | None] = mapped_column(Integer)
    actual_bytes: Mapped[int | None] = mapped_column(Integer)
    sha256: Mapped[str | None] = mapped_column(Text)
    mime_type: Mapped[str | None] = mapped_column(Text)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    failure_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)


class Photo(Base):
    __tablename__ = "photos"
    __table_args__ = (
        CheckConstraint(
            "mime_type IN ('image/jpeg', 'image/png', 'image/webp')",
            name="valid_mime_type",
        ),
        CheckConstraint("byte_size > 0", name="byte_size_positive"),
        CheckConstraint("length(sha256) = 64", name="hash_length"),
        CheckConstraint("width > 0", name="width_positive"),
        CheckConstraint("height > 0", name="height_positive"),
        CheckConstraint("length(note) <= 2000", name="note_length"),
        CheckConstraint("state IN ('active', 'trashed', 'purging')", name="valid_state"),
        CheckConstraint("revision >= 1", name="revision_positive"),
        CheckConstraint(
            "(state = 'active' AND position IS NOT NULL AND position >= 0 "
            "AND deleted_at IS NULL AND purge_after IS NULL) "
            "OR (state IN ('trashed', 'purging') AND position IS NULL "
            "AND deleted_at IS NOT NULL AND purge_after IS NOT NULL "
            "AND purge_after = deleted_at + 2592000000)",
            name="lifecycle_fields_match_state",
        ),
        UniqueConstraint("upload_item_id"),
        UniqueConstraint("storage_key"),
        ForeignKeyConstraint(
            ["album_id", "owner_id"],
            ["albums.id", "albums.owner_id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["upload_item_id", "owner_id"],
            ["upload_items.id", "upload_items.owner_id"],
            ondelete="RESTRICT",
        ),
        {"sqlite_strict": True},
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text)
    album_id: Mapped[str] = mapped_column(Text)
    upload_item_id: Mapped[str] = mapped_column(Text)
    storage_key: Mapped[str] = mapped_column(Text)
    original_filename: Mapped[str] = mapped_column(Text)
    mime_type: Mapped[str] = mapped_column(Text)
    byte_size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(Text)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(Text, default="", server_default="")
    state: Mapped[str] = mapped_column(Text, default="active", server_default="active")
    position: Mapped[int | None] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)
    deleted_at: Mapped[int | None] = mapped_column(Integer)
    purge_after: Mapped[int | None] = mapped_column(Integer)


Index(
    "uq_photos_active_position",
    Photo.album_id,
    Photo.position,
    unique=True,
    sqlite_where=Photo.state == "active",
)
Index(
    "ix_photos_duplicate_hint",
    Photo.owner_id,
    Photo.album_id,
    Photo.sha256,
    sqlite_where=Photo.state == "active",
)
Index("ix_photos_trash", Photo.owner_id, Photo.state, Photo.deleted_at)
Index("ix_photos_purge", Photo.state, Photo.purge_after)
