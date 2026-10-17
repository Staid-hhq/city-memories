-- Stage 6 design fixture, not a production migration.
-- Run only against a fresh in-memory/test database. No user data or map geometry.
-- Application connections must also enable foreign_keys before transactions.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT NOT NULL PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

-- user_id NULL identifies a short-lived anonymous CSRF session.
CREATE TABLE sessions (
    token_hash TEXT NOT NULL PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER
) STRICT;
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_sessions_expiry ON sessions(expires_at);

CREATE TABLE auth_rate_limits (
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key_hash, window_start)
) STRICT;
CREATE INDEX ix_auth_rate_limits_expiry ON auth_rate_limits(expires_at);

-- Minimal business mapping only. Third-party catalogue/geometry is not bundled.
CREATE TABLE cities (
    id TEXT NOT NULL PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_code TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_name TEXT,
    unit_kind TEXT NOT NULL,
    mapping_status TEXT NOT NULL CHECK (mapping_status IN ('pending', 'verified')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    UNIQUE (provider, provider_code)
) STRICT;

CREATE TABLE albums (
    id TEXT NOT NULL PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    year INTEGER CHECK (year IS NULL OR year BETWEEN 1 AND 9999),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (id, owner_id)
) STRICT;
CREATE UNIQUE INDEX uq_albums_year ON albums(owner_id, city_id, year)
    WHERE year IS NOT NULL;
CREATE UNIQUE INDEX uq_albums_unmarked ON albums(owner_id, city_id)
    WHERE year IS NULL;

CREATE TABLE import_batches (
    id TEXT NOT NULL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    album_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    expected_count INTEGER NOT NULL CHECK (expected_count > 0),
    state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'committed', 'canceled', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    committed_at INTEGER,
    commit_request_hash TEXT,
    commit_result_json TEXT,
    UNIQUE (id, owner_id),
    UNIQUE (owner_id, request_key),
    FOREIGN KEY (album_id, owner_id) REFERENCES albums(id, owner_id) ON DELETE RESTRICT,
    CHECK (
        (state = 'committed' AND committed_at IS NOT NULL
            AND commit_request_hash IS NOT NULL AND commit_result_json IS NOT NULL)
        OR (state <> 'committed' AND committed_at IS NULL
            AND commit_request_hash IS NULL AND commit_result_json IS NULL)
    )
) STRICT;
CREATE INDEX ix_import_batches_album ON import_batches(album_id, owner_id);
CREATE INDEX ix_import_batches_expiry ON import_batches(state, expires_at);

CREATE TABLE upload_items (
    id TEXT NOT NULL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    original_filename TEXT NOT NULL,
    expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
    expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
    storage_key TEXT NOT NULL UNIQUE,
    -- Reserved before a photo exists; retained as an idempotency receipt after purge.
    reserved_photo_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'receiving', 'staged', 'failed', 'committed', 'discarded')),
    attempt_token TEXT,
    lease_until INTEGER,
    actual_bytes INTEGER,
    sha256 TEXT,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (batch_id, item_index),
    UNIQUE (id, owner_id),
    FOREIGN KEY (batch_id, owner_id) REFERENCES import_batches(id, owner_id) ON DELETE RESTRICT,
    CHECK (
        (state = 'receiving' AND attempt_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (state <> 'receiving' AND attempt_token IS NULL AND lease_until IS NULL)
    ),
    CHECK (state NOT IN ('staged', 'committed') OR (
        actual_bytes IS NOT NULL AND actual_bytes = expected_bytes
        AND sha256 IS NOT NULL AND sha256 = expected_sha256
        AND mime_type IS NOT NULL AND mime_type IN ('image/jpeg', 'image/png', 'image/webp')
        AND width IS NOT NULL AND width > 0 AND height IS NOT NULL AND height > 0
    ))
) STRICT;

CREATE TABLE photos (
    id TEXT NOT NULL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    album_id TEXT NOT NULL,
    upload_item_id TEXT NOT NULL UNIQUE,
    storage_key TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'trashed', 'purging')),
    position INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    purge_after INTEGER,
    FOREIGN KEY (album_id, owner_id) REFERENCES albums(id, owner_id) ON DELETE RESTRICT,
    FOREIGN KEY (upload_item_id, owner_id) REFERENCES upload_items(id, owner_id) ON DELETE RESTRICT,
    CHECK (
        (state = 'active' AND position IS NOT NULL AND position >= 0
            AND deleted_at IS NULL AND purge_after IS NULL)
        OR (state IN ('trashed', 'purging') AND position IS NULL
            AND deleted_at IS NOT NULL AND purge_after IS NOT NULL
            AND purge_after = deleted_at + 2592000000)
    )
) STRICT;
CREATE UNIQUE INDEX uq_photos_active_position ON photos(album_id, position)
    WHERE state = 'active';
-- Hash is intentionally NOT unique: the owner decides which duplicates to keep.
CREATE INDEX ix_photos_duplicate_hint ON photos(owner_id, album_id, sha256)
    WHERE state = 'active';
CREATE INDEX ix_photos_trash ON photos(owner_id, state, deleted_at);
CREATE INDEX ix_photos_purge ON photos(state, purge_after);
