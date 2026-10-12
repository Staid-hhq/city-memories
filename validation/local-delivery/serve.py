"""T16 only: migrate a fresh directory; no users, albums or photos are seeded."""

import json
import os
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from alembic import command
from alembic.config import Config

from city_memories.config import Settings, get_settings
from city_memories.main import create_app

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "validation/local-delivery/results"


if __name__ == "__main__":
    RESULTS.mkdir(parents=True, exist_ok=True)
    # Retain this small synthetic database for local verification, never Git.
    with TemporaryDirectory(prefix="t16-runtime-", dir=RESULTS, delete=False) as temporary:
        directory = Path(temporary).resolve()
        assert directory.parent == RESULTS.resolve()
        (directory / "t16-isolated.txt").write_text("synthetic-only", encoding="utf-8")
        os.environ["CITY_MEMORIES_DATA_DIR"] = str(directory)
        get_settings.cache_clear()
        command.upgrade(Config(ROOT / "backend/alembic.ini"), "head")
        settings = Settings(
            data_dir=directory, _env_file=None, auth_secret=None, cookie_secure=False,
            allowed_origins=["http://127.0.0.1:5173", "http://127.0.0.1:8000"],
            cleanup_enabled=True, cleanup_interval_seconds=60,
            map_key=None, map_key_file=None, map_review_number="", map_review_date="",
        )
        with sqlite3.connect(settings.database_path) as db:
            counts = {
                name: db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
                for name in ("users", "albums", "photos")
            }
            migration = db.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        assert counts == {"users": 0, "albums": 0, "photos": 0}
        (RESULTS / "startup.json").write_text(json.dumps({
            "data_dir": str(directory), "initial_counts": counts,
            "migration": migration, "map_enabled": False,
        }, indent=2), encoding="utf-8")
        uvicorn.run(
            create_app(settings), host="127.0.0.1", port=8000,
            proxy_headers=False, access_log=False,
        )
