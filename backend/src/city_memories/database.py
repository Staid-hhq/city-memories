from collections.abc import Iterator
from contextlib import contextmanager
from sqlite3 import Connection as SQLiteConnection

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from city_memories.config import Settings, get_settings


def _configure_sqlite_connection(
    dbapi_connection: SQLiteConnection,
    _connection_record: object,
) -> None:
    """为连接池创建的每个 SQLite 连接启用项目要求的设置。"""

    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.execute("PRAGMA busy_timeout = 5000")
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.execute("PRAGMA synchronous = NORMAL")
    finally:
        cursor.close()


def build_engine(settings: Settings) -> Engine:
    settings.ensure_data_directories()
    engine = create_engine(settings.database_url)
    event.listen(engine, "connect", _configure_sqlite_connection)
    return engine


settings = get_settings()
engine = build_engine(settings)
SessionFactory = sessionmaker(bind=engine, expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    """提供显式提交和异常回滚的短事务边界。"""

    with SessionFactory() as session:
        with session.begin():
            yield session


def get_session() -> Iterator[Session]:
    with SessionFactory() as session:
        yield session
