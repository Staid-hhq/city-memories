from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    """从环境变量读取本地运行配置。"""

    model_config = SettingsConfigDict(
        env_prefix="CITY_MEMORIES_",
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = PROJECT_ROOT / ".local-data"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "database" / "city-memories.sqlite3"

    @property
    def originals_dir(self) -> Path:
        return self.data_dir / "originals"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    @property
    def database_url(self) -> str:
        return f"sqlite+pysqlite:///{self.database_path.resolve().as_posix()}"

    def ensure_data_directories(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.originals_dir.mkdir(parents=True, exist_ok=True)
        self.staging_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
