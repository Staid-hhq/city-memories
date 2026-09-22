from sqlite3 import Connection as SQLiteConnection

from sqlalchemy import Engine, create_engine, event

from city_memories.config import Settings


def _configure_sqlite_connection(
    dbapi_connection: SQLiteConnection,
    _connection_record: object,
) -> None:
    """为连接池创建的每个 SQLite 连接启用项目要求的设置。"""

    # PRAGMA foreign_keys / WAL 必须在事务之外执行。
    previous_autocommit = dbapi_connection.autocommit
    dbapi_connection.autocommit = True
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.execute("PRAGMA busy_timeout = 5000")
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.execute("PRAGMA synchronous = NORMAL")
    finally:
        cursor.close()
        dbapi_connection.autocommit = previous_autocommit


def build_engine(settings: Settings) -> Engine:
    settings.ensure_data_directories()
    engine = create_engine(
        settings.database_url,
        connect_args={"autocommit": False, "check_same_thread": False},
    )
    event.listen(engine, "connect", _configure_sqlite_connection)
    return engine
