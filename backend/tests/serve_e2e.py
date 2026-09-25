"""仅供 Playwright 使用：空临时数据库、无真实资料的本机服务。"""

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import uvicorn
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from photo_fixtures import seed_photos
from pwdlib import PasswordHash
from sqlalchemy import select
from sqlalchemy.orm import Session

from city_memories.config import Settings, get_settings
from city_memories.database import build_engine
from city_memories.main import create_app
from city_memories.models import Album, User

if __name__ == "__main__":
    with TemporaryDirectory(prefix="city-memories-auth-e2e-") as directory:
        os.environ["CITY_MEMORIES_DATA_DIR"] = directory
        get_settings.cache_clear()
        command.upgrade(Config(Path(__file__).resolve().parents[1] / "alembic.ini"), "head")
        # Isolated synthetic fixtures, never production accounts. Auth UI tests
        # still exercise the unchanged registration quota with their own users.
        engine = build_engine(Settings(data_dir=Path(directory), _env_file=None))
        with Session(engine) as db, db.begin():
            password_hash = PasswordHash.recommended().hash("Only for T03 browser tests!")
            for username in (
                "Albums_One", "Albums_Two", "Photos_One", "Photos_Two", "Batch_One", "Batch_Two"
            ):
                db.add(
                    User(
                        id=str(uuid4()),
                        username=username,
                        username_key=username.lower(),
                        password_hash=password_hash,
                        created_at=1_800_000_000_000,
                    )
                )
        engine.dispose()
        app = create_app(
            Settings(
                data_dir=Path(directory), _env_file=None, auth_secret=None, cookie_secure=False
            )
        )
        with TestClient(app):
            with app.state.auth.sessions.begin() as db:
                owner = db.scalar(select(User.id).where(User.username == "Photos_One"))
                album_id = str(uuid4())
                db.add(
                    Album(
                        id=album_id,
                        owner_id=owner,
                        city_id="a03b8f10-06dd-4b56-aef1-33cfc3696301",
                        year=2035,
                        revision=1,
                        created_at=1_800_000_000_000,
                        updated_at=1_800_000_000_000,
                    )
                )
            seed_photos(app, owner, album_id)
        uvicorn.run(app, host="127.0.0.1", port=8000, proxy_headers=False, access_log=False)
