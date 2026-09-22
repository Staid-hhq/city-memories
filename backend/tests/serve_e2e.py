"""仅供 Playwright 使用：空临时数据库、无真实资料的本机服务。"""

import os
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from alembic import command
from alembic.config import Config

from city_memories.config import Settings, get_settings
from city_memories.main import create_app

if __name__ == "__main__":
    with TemporaryDirectory(prefix="city-memories-auth-e2e-") as directory:
        os.environ["CITY_MEMORIES_DATA_DIR"] = directory
        get_settings.cache_clear()
        command.upgrade(Config(Path(__file__).resolve().parents[1] / "alembic.ini"), "head")
        app = create_app(
            Settings(
                data_dir=Path(directory), _env_file=None, auth_secret=None, cookie_secure=False
            )
        )
        uvicorn.run(app, host="127.0.0.1", port=8000, proxy_headers=False, access_log=False)
