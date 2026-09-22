from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import SecretStr, field_validator
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
    allowed_origins: list[str] = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]
    cookie_secure: bool = False
    auth_secret: SecretStr | None = None

    @field_validator("allowed_origins")
    @classmethod
    def validate_origins(cls, origins: list[str]) -> list[str]:
        if not origins:
            raise ValueError("至少配置一个可信来源")
        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.username
            ):
                raise ValueError("来源必须是完整的 http(s) origin，不含路径和凭据")
        return origins

    @field_validator("auth_secret")
    @classmethod
    def validate_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value().encode()) < 32:
            raise ValueError("认证密钥至少需要 32 字节")
        return value

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
