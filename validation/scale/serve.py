"""Dedicated T15 server, fresh isolated data and no map key or production config."""

import argparse
import json
import os
from contextlib import nullcontext
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import uvicorn
from alembic import command
from alembic.config import Config
from city_memories.config import Settings, get_settings
from city_memories.main import create_app

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "validation/scale/results"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--resume", action="store_true", help="Reuse only the marked last T15 runtime"
    )
    args = parser.parse_args()
    RESULTS.mkdir(parents=True, exist_ok=True)
    if args.resume:
        previous = json.loads((RESULTS / "server.json").read_text(encoding="utf-8"))
        directory = Path(previous["data_dir"]).resolve()
        assert directory.parent == RESULTS.resolve() and directory.name.startswith("t15-runtime-")
        assert (directory / "t15-isolated.txt").read_text(encoding="utf-8") == "synthetic-only"
        runtime = nullcontext(str(directory))
    else:
        runtime = TemporaryDirectory(prefix="t15-runtime-", dir=RESULTS, delete=False)
    # Retain only this synthetic runtime for the post-server audit/maintenance run.
    with runtime as temporary:
        directory = Path(temporary).resolve()
        assert directory.parent == RESULTS.resolve()
        (directory / "t15-isolated.txt").write_text("synthetic-only", encoding="utf-8")
        os.environ["CITY_MEMORIES_DATA_DIR"] = str(directory)
        get_settings.cache_clear()
        if not args.resume:
            command.upgrade(Config(ROOT / "backend/alembic.ini"), "head")
        identity = str(uuid4())
        (RESULTS / "server.json").write_text(
            json.dumps({"pid": os.getpid(), "data_dir": str(directory), "identity": identity}),
            encoding="utf-8",
        )
        app = create_app(
            Settings(
                data_dir=directory,
                _env_file=None,
                auth_secret=None,
                cookie_secure=False,
                map_key=None,
                map_key_file=None,
                map_review_date="",
                map_review_number="",
            )
        )

        @app.get("/t15-isolated-identity", include_in_schema=False)
        def isolated_identity():
            return {"identity": identity}

        uvicorn.run(app, host="127.0.0.1", port=8000, proxy_headers=False, access_log=False)
