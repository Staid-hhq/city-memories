from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from city_memories.config import Settings, get_settings
from city_memories.database import build_engine
from city_memories.models import User

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_migration_creates_expected_schema(tmp_path, monkeypatch) -> None:
    _upgrade(tmp_path, monkeypatch)

    engine = build_engine(Settings(data_dir=tmp_path))
    assert set(inspect(engine).get_table_names()) == {
        "alembic_version",
        "albums",
        "auth_rate_limits",
        "cities",
        "import_batches",
        "photos",
        "sessions",
        "upload_items",
        "users",
    }
    with engine.connect() as connection:
        assert connection.scalar(text("PRAGMA integrity_check")) == "ok"


def test_every_connection_enables_foreign_keys_and_wal(tmp_path) -> None:
    engine = build_engine(Settings(data_dir=tmp_path))

    for _ in range(2):
        with engine.connect() as connection:
            assert connection.scalar(text("PRAGMA foreign_keys")) == 1
            assert connection.scalar(text("PRAGMA journal_mode")) == "wal"
            assert connection.scalar(text("PRAGMA busy_timeout")) == 5000
        engine.dispose()


def test_foreign_key_rejects_unknown_user(tmp_path, monkeypatch) -> None:
    settings = Settings(data_dir=tmp_path)
    _upgrade(tmp_path, monkeypatch)
    engine = build_engine(settings)

    with engine.connect() as connection, pytest.raises(IntegrityError):
        with connection.begin():
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) "
                    "VALUES ('token', 'missing', 'csrf', 1, 2, 1)"
                )
            )


def test_transaction_rolls_back_on_error(tmp_path, monkeypatch) -> None:
    settings = Settings(data_dir=tmp_path)
    _upgrade(tmp_path, monkeypatch)
    engine = build_engine(settings)
    user_id = str(uuid4())

    with pytest.raises(RuntimeError), Session(engine) as session, session.begin():
        session.add(
            User(
                id=user_id,
                username="traveler",
                username_key="traveler",
                password_hash="not-a-real-password-hash",
                created_at=1,
            )
        )
        session.flush()
        raise RuntimeError("force rollback")

    with Session(engine) as session:
        assert session.scalar(select(User).where(User.id == user_id)) is None


def test_wal_reader_has_stable_snapshot_while_writer_commits(tmp_path, monkeypatch) -> None:
    _upgrade(tmp_path, monkeypatch)
    engine = build_engine(Settings(data_dir=tmp_path))
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, username, username_key, password_hash, created_at) "
                "VALUES ('snapshot-user', 'before', 'before', 'test-fixture-only', 1)"
            )
        )
    with engine.connect() as reader:
        assert reader.scalar(text("SELECT username FROM users")) == "before"
        with engine.begin() as writer:
            writer.execute(text("UPDATE users SET username = 'after'"))
        assert reader.scalar(text("SELECT username FROM users")) == "before"
        reader.rollback()
        assert reader.scalar(text("SELECT username FROM users")) == "after"
    engine.dispose()


def _upgrade(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CITY_MEMORIES_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    config = Config(BACKEND_ROOT / "alembic.ini")
    try:
        command.upgrade(config, "head")
    finally:
        get_settings.cache_clear()
