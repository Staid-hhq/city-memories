"""Offline, fail-closed backup/restore. Only new output directories are writable."""

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from city_memories.cleanup import (
    BACKUP_MANIFEST,
    INCOMPLETE_MARKER,
    InstanceLock,
    ManagedDirectory,
    assert_data_ready,
)
from city_memories.models import Base
from city_memories.storage import CHUNK_SIZE

SCHEMA_REVISION = "b61e24f803a7"
DATABASE_NAME = "city-memories.sqlite3"
MANIFEST_LIMIT = 64 * 1024 * 1024
HASH = r"^[a-f0-9]{64}$"
KEY = r"^[a-f0-9]{32}$"


class BackupError(Exception):
    """Messages are fixed text: never disclose database values or filesystem errors."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class FileDigest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    byte_size: int = Field(ge=1)
    sha256: str = Field(pattern=HASH)


class PhotoRecord(FileDigest):
    id: str
    owner_id: str
    album_id: str
    storage_key: str = Field(pattern=KEY)
    state: Literal["active", "trashed"]
    purge_after: int | None
    metadata_sha256: str = Field(pattern=HASH)


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    format: Literal["city-memories-backup"]
    version: Literal[1]
    schema_revision: Literal["b61e24f803a7"]
    snapshot_at: int = Field(ge=0)
    database: FileDigest
    counts: dict[str, int]
    photos: list[PhotoRecord]


def _now() -> int:
    return time.time_ns() // 1_000_000


def _fail(code="INVALID_BACKUP", message="备份不完整、损坏或不兼容，未开放恢复目录"):
    raise BackupError(code, message)


def _absolute(path: Path) -> Path:
    path = Path(os.path.abspath(path))
    if path.drive.startswith("\\\\") or path.resolve() != path:
        _fail("UNSAFE_PATH", "只能使用未重定向的本地目录，不支持网络路径或链接")
    return path


def _regular(path: Path):
    path = _absolute(path)
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or path.is_symlink()
        or path.is_junction()
    ):
        _fail("UNSAFE_FILE", "拒绝链接或非独立普通文件")
    return info


def _destination(path: Path, source: Path) -> Path:
    path = _absolute(path)
    if path == source or path.is_relative_to(source) or source.is_relative_to(path):
        _fail("OVERLAPPING_PATHS", "来源和目标目录不能相同或互相包含")
    if path.exists() or path.is_symlink() or path.is_junction():
        _fail("DESTINATION_EXISTS", "目标必须是尚不存在的新目录，不覆盖或合并已有内容")
    ManagedDirectory(path.parent)
    # New private artifacts never belong in a checkout, even if ignored.
    if any((parent / ".git").exists() for parent in (path.parent, *path.parents)):
        _fail("PUBLIC_WORKSPACE", "备份与恢复目标必须位于 Git 工作区之外")
    return path


@contextmanager
def _locked(root: Path):
    guard = ManagedDirectory(root)
    lock = InstanceLock(root)
    try:
        lock.__enter__()
    except RuntimeError:
        _fail("MAINTENANCE_BUSY", "请先正常停止后端及其他维护命令，再重试；不要删除锁文件")
    try:
        guard.check()
        yield guard
        guard.check()
    finally:
        lock.__exit__(None, None, None)


@contextmanager
def _new_output(root: Path):
    # No recursive deletion on failure: preserve an explicitly incomplete output.
    root.mkdir(mode=0o700, exist_ok=False)
    with _locked(root) as guard:
        _write_json(root / INCOMPLETE_MARKER, {"status": "incomplete"})
        (root / "database").mkdir(mode=0o700)
        (root / "originals").mkdir(mode=0o700)
        yield
        guard.check()
        (root / INCOMPLETE_MARKER).unlink()


def _write_json(path, value):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _fingerprint(row) -> str:
    return hashlib.sha256(
        json.dumps(dict(row), ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
    ).hexdigest()


def _file_digest(path: Path, destination: Path | None = None) -> FileDigest:
    info = _regular(path)
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        opened = os.fstat(source.fileno())
        if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
            _fail("FILE_CHANGED", "文件在检查期间发生变化，请停止其他文件操作后重试")
        output = destination.open("xb") if destination is not None else None
        try:
            while chunk := source.read(CHUNK_SIZE):
                size += len(chunk)
                if size > info.st_size:
                    _fail("FILE_CHANGED", "文件在检查期间发生变化，请停止其他文件操作后重试")
                digest.update(chunk)
                if output:
                    output.write(chunk)
            if output:
                output.flush()
                os.fsync(output.fileno())
        finally:
            if output:
                output.close()
    after = _regular(path)
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        _fail("FILE_CHANGED", "文件在检查期间发生变化，请停止其他文件操作后重试")
    return FileDigest(byte_size=size, sha256=digest.hexdigest())


@contextmanager
def _database(path: Path, *, writable=False, immutable=False):
    _regular(path)
    suffix = "?mode=rw" if writable else "?mode=ro"
    if immutable:
        suffix += "&immutable=1"  # Only published backup DBs without any WAL.
    db = sqlite3.connect(path.as_uri() + suffix, uri=True, isolation_level=None, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("PRAGMA foreign_keys=ON")
        yield db
    finally:
        db.close()


def _check_database(db):
    names = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if names != set(Base.metadata.tables) | {"alembic_version"}:
        _fail()
    if db.execute("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')").fetchone():
        _fail()
    if [row[0] for row in db.execute("SELECT version_num FROM alembic_version")] != [
        SCHEMA_REVISION
    ]:
        _fail("SCHEMA_MISMATCH", "数据库版本不兼容，请使用匹配版本的工具；不自动迁移备份")
    for name, table in Base.metadata.tables.items():
        columns = [row["name"] for row in db.execute(f'PRAGMA table_info("{name}")')]
        if columns != list(table.columns.keys()):
            _fail()
    if [row[0] for row in db.execute("PRAGMA integrity_check")] != ["ok"]:
        _fail()
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        _fail()


def _inventory(db):
    counts = {
        name: db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
        for name in Base.metadata.tables
    }
    photos = [
        PhotoRecord(
            **{
                key: row[key]
                for key in (
                    "id",
                    "owner_id",
                    "album_id",
                    "storage_key",
                    "state",
                    "purge_after",
                    "byte_size",
                    "sha256",
                )
            },
            metadata_sha256=_fingerprint(row),
        )
        for row in db.execute("SELECT * FROM photos ORDER BY id")
    ]
    return counts, photos


def _sanitize(db, cutoff: int):
    # Only the new snapshot/restore DB is changed, never the source database.
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("PRAGMA secure_delete=ON")
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "DELETE FROM photos WHERE state='purging' OR (state='trashed' AND purge_after<=?)",
            (cutoff,),
        )
        db.execute("DELETE FROM sessions")
        db.execute("DELETE FROM auth_rate_limits")
        db.execute("UPDATE import_batches SET state='canceled' WHERE state='open'")
        db.execute(
            "UPDATE upload_items SET state='discarded', attempt_token=NULL, lease_until=NULL, "
            "failure_code='IMPORT_CLOSED', updated_at=? "
            "WHERE state NOT IN ('committed','discarded')",
            (cutoff,),
        )
    db.execute("VACUUM")  # Do not carry deleted sessions/private rows in freelist pages.
    _check_database(db)


def _copy_database(source: Path, destination: Path):
    # SQLite Backup API includes committed WAL; no loose copy of a live .sqlite3 file.
    with destination.open("xb"):
        pass
    with _database(source) as original, _database(destination, writable=True) as snapshot:
        original.backup(snapshot, pages=256, sleep=0.01)


def _layout(root: Path, *, building=False):
    if not building and (root / INCOMPLETE_MARKER).exists():
        _fail("INCOMPLETE_BACKUP", "这是未完成的备份，不能校验通过或恢复")
    allowed = {"database", "originals", BACKUP_MANIFEST, "maintenance.lock"}
    if building:
        allowed.add(INCOMPLETE_MARKER)
    if {entry.name for entry in root.iterdir()} != allowed:
        _fail()
    for folder in ("database", "originals"):
        ManagedDirectory(root / folder)
    if {entry.name for entry in (root / "database").iterdir()} != {DATABASE_NAME}:
        _fail()


def _unique_json(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _fail()
        value[key] = item
    return value


def _verify_locked(root: Path, *, building=False) -> Manifest:
    _layout(root, building=building)
    path = root / BACKUP_MANIFEST
    if _regular(path).st_size > MANIFEST_LIMIT:
        _fail()
    payload = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_json)
    if not isinstance(payload, dict) or type(payload.get("version")) is not int:
        _fail()
    manifest = Manifest.model_validate(payload)
    database = root / "database" / DATABASE_NAME
    if _file_digest(database) != manifest.database:
        _fail("CHECKSUM_MISMATCH", "文件校验失败，备份未通过；不要使用此副本恢复")
    with _database(database, immutable=True) as db:
        _check_database(db)
        counts, photos = _inventory(db)
        if counts != manifest.counts or photos != manifest.photos:
            _fail()
        if counts["sessions"] or counts["auth_rate_limits"]:
            _fail()
        if db.execute("SELECT 1 FROM import_batches WHERE state='open'").fetchone():
            _fail()
        if db.execute(
            "SELECT 1 FROM upload_items WHERE state NOT IN ('committed','discarded')"
        ).fetchone():
            _fail()
    keys = {photo.storage_key for photo in photos}
    if len(keys) != len(photos) or len({photo.id for photo in photos}) != len(photos):
        _fail()
    if {entry.name for entry in (root / "originals").iterdir()} != keys:
        _fail()
    for photo in photos:
        if photo.state == "trashed" and (
            photo.purge_after is None or photo.purge_after <= manifest.snapshot_at
        ):
            _fail()
        actual = _file_digest(root / "originals" / photo.storage_key)
        if actual != FileDigest(byte_size=photo.byte_size, sha256=photo.sha256):
            _fail("CHECKSUM_MISMATCH", "原图校验失败，备份未通过；不要使用此副本恢复")
    return manifest


def _summary(manifest: Manifest, *, photos=None):
    photos = manifest.photos if photos is None else photos
    return {
        "users": manifest.counts["users"],
        "albums": manifest.counts["albums"],
        "active_photos": sum(photo.state == "active" for photo in photos),
        "trashed_photos": sum(photo.state == "trashed" for photo in photos),
        "original_bytes": sum(photo.byte_size for photo in photos),
    }


def create_backup(data_dir: Path, destination: Path, *, clock=_now) -> dict:
    source = _absolute(data_dir)
    target = _destination(destination, source)
    with _locked(source) as source_guard:
        assert_data_ready(source)
        originals = ManagedDirectory(source / "originals")
        database_guard = ManagedDirectory(source / "database")
        database = source / "database" / DATABASE_NAME
        _regular(database)
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = database.with_name(DATABASE_NAME + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                _regular(sidecar)
        cutoff = clock()
        with _new_output(target):
            copied_db = target / "database" / DATABASE_NAME
            _copy_database(database, copied_db)
            with _database(copied_db, writable=True) as db:
                _check_database(db)
                _sanitize(db, cutoff)
                counts, photos = _inventory(db)
            for photo in photos:
                originals.check()
                actual = _file_digest(
                    source / "originals" / photo.storage_key,
                    target / "originals" / photo.storage_key,
                )
                if actual != FileDigest(byte_size=photo.byte_size, sha256=photo.sha256):
                    _fail("SOURCE_MISMATCH", "原图缺失或内容不符，备份失败；保留源数据并先排查")
            manifest = Manifest(
                format="city-memories-backup",
                version=1,
                schema_revision=SCHEMA_REVISION,
                snapshot_at=cutoff,
                database=_file_digest(copied_db),
                counts=counts,
                photos=photos,
            )
            source_guard.check()
            originals.check()
            database_guard.check()
            _write_json(target / BACKUP_MANIFEST, manifest.model_dump())
            _verify_locked(target, building=True)  # Validate before removing the failure marker.
    return _summary(manifest)


def verify_backup(backup_dir: Path) -> dict:
    root = _absolute(backup_dir)
    with _locked(root):
        return _summary(_verify_locked(root))


def restore_backup(backup_dir: Path, destination: Path, *, clock=_now) -> dict:
    source = _absolute(backup_dir)
    target = _destination(destination, source)
    with _locked(source):
        manifest = _verify_locked(source)
        started_at = clock()
        if started_at < manifest.snapshot_at:
            _fail("CLOCK_ROLLBACK", "系统时间早于备份时间，请核对时钟后再恢复")
        originals = ManagedDirectory(source / "originals")
        with _new_output(target):
            database = target / "database" / DATABASE_NAME
            if _file_digest(source / "database" / DATABASE_NAME, database) != manifest.database:
                _fail()
            copied = [
                photo
                for photo in manifest.photos
                if photo.state == "active" or photo.purge_after > started_at
            ]
            for photo in copied:
                originals.check()
                actual = _file_digest(
                    source / "originals" / photo.storage_key,
                    target / "originals" / photo.storage_key,
                )
                if actual != FileDigest(byte_size=photo.byte_size, sha256=photo.sha256):
                    _fail()
            cutoff = max(started_at, clock())
            with _database(database, writable=True) as db:
                _check_database(db)
                _sanitize(db, cutoff)
                counts, photos = _inventory(db)
            expected = [
                photo
                for photo in manifest.photos
                if photo.state == "active" or photo.purge_after > cutoff
            ]
            expected_counts = manifest.counts | {"photos": len(expected)}
            if photos != expected or counts != expected_counts:
                _fail()
            keep = {photo.storage_key for photo in photos}
            output = ManagedDirectory(target / "originals")
            for photo in copied:
                if photo.storage_key not in keep:
                    output.unlink(photo.storage_key)  # Only this newly written restore copy.
            for photo in photos:
                if _file_digest(target / "originals" / photo.storage_key) != FileDigest(
                    byte_size=photo.byte_size, sha256=photo.sha256
                ):
                    _fail()
            (target / "staging").mkdir(mode=0o700)
            # No auth secret/config copied; first startup generates a fresh local secret.
    return _summary(manifest, photos=photos) | {
        "expired_excluded": len(manifest.photos) - len(photos),
        "sessions_invalidated": True,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="城影记离线备份：先正常停止后端，仅写全新目录")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="创建一致备份，不改变源数据")
    create.add_argument("--data-dir", required=True, type=Path)
    create.add_argument("--destination", required=True, type=Path)
    verify = commands.add_parser("verify", help="完整校验备份，不启动应用")
    verify.add_argument("--backup", required=True, type=Path)
    restore = commands.add_parser("restore", help="校验并恢复到新目录，旧会话失效")
    restore.add_argument("--backup", required=True, type=Path)
    restore.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            result = create_backup(args.data_dir, args.destination)
        elif args.command == "verify":
            result = verify_backup(args.backup)
        else:
            result = restore_backup(args.backup, args.destination)
    except BackupError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error, ValueError, ValidationError, RuntimeError):
        # Paths, passwords, rows and raw exceptions never appear in CLI diagnostics.
        print(
            "MAINTENANCE_FAILED: 操作未完成，请检查版本、完整性、空间、权限和文件占用；"
            "不覆盖已有目录，失败产物不能用于恢复或启动。",
            file=sys.stderr,
        )
        return 1
    print(json.dumps({"status": "ok", "operation": args.command, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
