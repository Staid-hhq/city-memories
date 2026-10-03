"""Bounded, retryable maintenance of private system copies, never source files."""

import logging
import os
import re
import stat
import threading
from bisect import bisect_right
from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass
from pathlib import Path

from sqlalchemy import delete, or_, select, tuple_, update

from city_memories.imports import DAY, ImportService
from city_memories.models import AuthRateLimit, ImportBatch, LoginSession, Photo, UploadItem

logger = logging.getLogger(__name__)
ROW_LIMIT = 100
SCAN_LIMIT = 200
AUTH_LIMIT = 500
MANAGED_NAME = re.compile(r"([a-f0-9]{32})(?:\.([a-f0-9]{32})\.part)?\Z")
INCOMPLETE_MARKER = ".maintenance-incomplete"
BACKUP_MANIFEST = "backup-manifest.json"


def assert_data_ready(directory: Path) -> None:
    # Check before creating directories, and again after acquiring the instance lock.
    if (directory / INCOMPLETE_MARKER).exists() or (directory / BACKUP_MANIFEST).exists():
        raise RuntimeError("不能启动未完成的维护目录或备份目录，请先恢复到新的数据目录")


class ManagedDirectory:
    """Only direct regular files in the same non-redirected directory are removable."""

    def __init__(self, directory: Path):
        self.root = Path(os.path.abspath(directory))
        self.identity = None
        self.check()
        info = self.root.stat()
        self.identity = (info.st_dev, info.st_ino)

    def check(self):
        if (
            self.root.is_symlink()
            or self.root.is_junction()
            or self.root.resolve() != self.root
            or not self.root.is_dir()
        ):
            raise OSError("Private storage directory is redirected or unavailable")
        info = self.root.stat()
        if self.identity is not None and (info.st_dev, info.st_ino) != self.identity:
            raise OSError("Private storage directory identity changed")

    def file(self, name: str):
        self.check()
        if not MANAGED_NAME.fullmatch(name):
            raise OSError("Not a system-generated file name")
        path = self.root / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            return path, None
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or path.is_symlink()
            or path.is_junction()
            or path.resolve().parent != self.root
        ):
            raise OSError("Not an independent regular system file")
        return path, info

    def unlink(self, name: str) -> bool:
        path, info = self.file(name)
        if info is None:
            return False
        path.unlink()  # One validated file. Never recursive; do not follow links.
        return True


class InstanceLock(AbstractContextManager):
    """An OS lock is released even after a process crash; the lock file stays."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.stream = None

    def __enter__(self):
        root = Path(os.path.abspath(self.directory))
        path = root / "maintenance.lock"
        if (
            root.resolve() != root
            or path.is_symlink()
            or path.is_junction()
            or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1))
        ):
            raise RuntimeError("私有目录不能通过链接重定向")
        stream = path.open("a+b")
        try:
            if stream.tell() == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            stream.close()
            raise RuntimeError("同一私有数据目录只能运行一个服务实例，请先停止旧服务") from None
        self.stream = stream
        return self

    def __exit__(self, *args):
        if self.stream:
            self.stream.close()
            self.stream = None


@dataclass
class CleanupReport:
    imports_expired: int = 0
    leases_failed: int = 0
    photos_marked: int = 0
    photos_removed: int = 0
    files_removed: int = 0
    sessions_removed: int = 0
    rate_limits_removed: int = 0
    failures: int = 0
    busy: bool = False


class CleanupService:
    def __init__(self, imports: ImportService):
        self.imports = imports
        self.auth = imports.auth
        self.sessions = imports.sessions
        self.originals = ManagedDirectory(imports.settings.originals_dir)
        self.staging = ManagedDirectory(imports.settings.staging_dir)
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread = None
        self.last_report = CleanupReport()
        self.photo_cursor = ""
        self.file_cursors = {"staging": "", "originals": ""}

    def start(self):
        self.run_once()
        self.thread = threading.Thread(target=self._loop, name="private-data-cleanup", daemon=True)
        self.thread.start()

    def _loop(self):
        interval = self.imports.settings.cleanup_interval_seconds
        while not self.stopping.wait(interval):
            self.run_once()

    def stop(self):
        self.stopping.set()
        if self.thread is not None:
            self.thread.join()  # Finish file/DB coordination before engine disposal.

    def run_once(self) -> CleanupReport:
        report = CleanupReport()
        if not self.lock.acquire(blocking=False):
            report.busy = True
            return report
        try:
            for phase in (self._imports, self._photos, self._auth_records):
                if self.stopping.is_set():
                    break
                try:
                    phase(report)
                except Exception:
                    # Never log exception strings, keys, filenames, paths or accounts.
                    report.failures += 1
            self.last_report = report
            if report.failures:
                logger.warning(
                    "Private-data cleanup incomplete; will retry. Counts: %s", asdict(report)
                )
            return report
        finally:
            self.lock.release()

    def _imports(self, report):
        # Publication and commit/cancel use this same process-wide lock. Avoid
        # queuing maintenance behind large imports (including during shutdown).
        if not self.imports.lock.acquire(blocking=False):
            report.busy = True
            return
        try:
            now = self.auth.clock()
            with self.sessions.begin() as db:
                due = (
                    select(ImportBatch.id)
                    .where(ImportBatch.state == "open", ImportBatch.expires_at <= now)
                    .order_by(ImportBatch.expires_at, ImportBatch.id)
                    .limit(ROW_LIMIT)
                )
                imports_expired = db.execute(
                    update(ImportBatch)
                    .where(
                        ImportBatch.id.in_(due),
                        ImportBatch.state == "open",
                        ImportBatch.expires_at <= now,
                    )
                    .values(state="expired")
                ).rowcount
                terminal = select(ImportBatch.id).where(
                    ImportBatch.state.in_(("expired", "canceled"))
                )
                discarded = (
                    select(UploadItem.id)
                    .where(
                        UploadItem.batch_id.in_(terminal),
                        UploadItem.state.not_in(("committed", "discarded")),
                    )
                    .limit(SCAN_LIMIT)
                )
                db.execute(
                    update(UploadItem)
                    .where(UploadItem.id.in_(discarded))
                    .values(
                        state="discarded",
                        attempt_token=None,
                        lease_until=None,
                        failure_code="IMPORT_CLOSED",
                        updated_at=now,
                    )
                )
                stale = (
                    select(UploadItem.id)
                    .where(UploadItem.state == "receiving", UploadItem.lease_until <= now)
                    .order_by(UploadItem.lease_until, UploadItem.id)
                    .limit(SCAN_LIMIT)
                )
                leases_failed = db.execute(
                    update(UploadItem)
                    .where(
                        UploadItem.id.in_(stale),
                        UploadItem.state == "receiving",
                        UploadItem.lease_until <= now,
                    )
                    .values(
                        state="failed",
                        attempt_token=None,
                        lease_until=None,
                        failure_code="UPLOAD_ATTEMPT_EXPIRED",
                        updated_at=now,
                    )
                ).rowcount
            report.imports_expired = imports_expired
            report.leases_failed = leases_failed
            for kind, directory in (("staging", self.staging), ("originals", self.originals)):
                self._scan(kind, directory, now, report)
        finally:
            self.imports.lock.release()

    def _scan(self, kind, directory, now, report):
        directory.check()
        names = sorted(path.name for path in directory.root.iterdir())
        offset = bisect_right(names, self.file_cursors[kind])
        if offset == len(names):
            offset = 0
        for name in names[offset : offset + SCAN_LIMIT]:
            if self.stopping.is_set():
                return
            self.file_cursors[kind] = name  # Failed entries cannot starve later files.
            match = MANAGED_NAME.fullmatch(name)
            if match is None or (kind == "originals" and match[2] is not None):
                continue
            try:
                _, info = directory.file(name)
                if info is None:
                    continue
                with self.sessions() as db:
                    # All photo states are protected here. Only _photos may
                    # unlink a purging original after its durable transition.
                    if (
                        kind == "originals"
                        and db.scalar(select(Photo.id).where(Photo.storage_key == match[1]))
                        is not None
                    ):
                        continue
                    row = db.execute(
                        select(UploadItem, ImportBatch)
                        .join(ImportBatch, UploadItem.batch_id == ImportBatch.id)
                        .where(UploadItem.storage_key == match[1])
                    ).first()
                    if row is None:
                        if info.st_mtime_ns // 1_000_000 + DAY > now:
                            continue  # Unknown system-looking files get a day of grace.
                    else:
                        item, batch = row
                        if batch.state == "open" and batch.expires_at > now:
                            if match[2] is not None:
                                if (
                                    item.state == "receiving"
                                    and item.attempt_token == match[2]
                                    and item.lease_until > now
                                ):
                                    continue
                            elif item.state == "staged" or (
                                kind == "staging"
                                and item.state == "receiving"
                                and item.lease_until > now
                            ):
                                # Also retain originals published before a failed
                                # DB transaction, for the user's explicit retry.
                                continue
                report.files_removed += directory.unlink(name)
            except Exception:
                report.failures += 1

    def _photos(self, report):
        now = self.auth.clock()
        with self.sessions.begin() as db:
            due = (
                select(Photo.id)
                .where(Photo.state == "trashed", Photo.purge_after <= now)
                .order_by(Photo.purge_after, Photo.id)
                .limit(ROW_LIMIT)
            )
            marked = db.execute(
                update(Photo)
                .where(
                    Photo.id.in_(due),
                    Photo.state == "trashed",
                    Photo.purge_after <= now,
                )
                .values(state="purging", revision=Photo.revision + 1, updated_at=now)
            ).rowcount
        report.photos_marked = marked
        with self.sessions() as db:
            query = select(Photo.id, Photo.storage_key).where(Photo.state == "purging")
            rows = db.execute(
                query.where(Photo.id > self.photo_cursor).order_by(Photo.id).limit(ROW_LIMIT)
            ).all()
            if not rows:
                rows = db.execute(query.order_by(Photo.id).limit(ROW_LIMIT)).all()
        for photo_id, key in rows:
            if self.stopping.is_set():
                return
            self.photo_cursor = photo_id
            try:
                report.files_removed += self.originals.unlink(key)
                with self.sessions.begin() as db:
                    # A failed unlink or DB commit leaves purging metadata.
                    # The next pass treats a missing file as success and finishes.
                    removed = db.execute(
                        delete(Photo).where(
                            Photo.id == photo_id,
                            Photo.state == "purging",
                            Photo.storage_key == key,
                        )
                    ).rowcount
                report.photos_removed += removed
            except Exception:
                report.failures += 1

    def _auth_records(self, report):
        now = self.auth.clock()
        with self.sessions.begin() as db:
            expired = (
                select(LoginSession.token_hash)
                .where(or_(LoginSession.expires_at <= now, LoginSession.revoked_at.is_not(None)))
                .order_by(LoginSession.expires_at)
                .limit(AUTH_LIMIT)
            )
            sessions_removed = db.execute(
                delete(LoginSession).where(LoginSession.token_hash.in_(expired))
            ).rowcount
            keys = (AuthRateLimit.scope, AuthRateLimit.key_hash, AuthRateLimit.window_start)
            due = select(*keys).where(AuthRateLimit.expires_at <= now).limit(AUTH_LIMIT)
            rate_limits_removed = db.execute(
                delete(AuthRateLimit).where(tuple_(*keys).in_(due))
            ).rowcount
        report.sessions_removed = sessions_removed
        report.rate_limits_removed = rate_limits_removed
