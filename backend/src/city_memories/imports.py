"""Single-instance import protocol; short DB transactions, independent original bytes."""

import hashlib
import json
import os
import threading
from datetime import UTC, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Header, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from python_multipart.exceptions import MultipartParseError
from sqlalchemy import func, select, update
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.requests import ClientDisconnect
from starlette.responses import FileResponse

from city_memories.albums import Envelope, not_found
from city_memories.auth import AuthService, CurrentUser
from city_memories.errors import ApiError
from city_memories.models import Album, ImportBatch, Photo, UploadItem
from city_memories.storage import (
    MAX_FILE_BYTES,
    matches,
    private_path,
    remove_temporary,
    write_and_validate,
)

DAY = 24 * 60 * 60 * 1000
LEASE = 15 * 60 * 1000
MULTIPART_OVERHEAD = 64 * 1024
router = APIRouter(prefix="/api/v1", tags=["imports"])


class BoundedMultipartParser(MultiPartParser):
    """Bound header accumulation independently of the permitted 50 MiB file."""

    header_bytes = 0

    def count_header(self, start: int, end: int) -> None:
        self.header_bytes += end - start
        if self.header_bytes > 16 * 1024:
            raise MultiPartException("Multipart headers too large")

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self.count_header(start, end)
        super().on_header_field(data, start, end)

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self.count_header(start, end)
        super().on_header_value(data, start, end)


class ItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original_filename: str = Field(min_length=1, max_length=255)
    byte_size: int = Field(strict=True, ge=1, le=MAX_FILE_BYTES)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("original_filename")
    @classmethod
    def safe_display_name(cls, name: str) -> str:
        if name in {".", ".."} or any(ord(char) < 32 or char in "/\\:" for char in name):
            raise ValueError("只接收文件名，不接收路径或控制字符")
        return name


class ImportInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ItemInput] = Field(min_length=1, max_length=400)


class CommitInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_album_revision: int = Field(strict=True, ge=1)
    allow_partial: bool = Field(default=False, strict=True)


class ItemView(BaseModel):
    id: str
    item_index: int
    original_filename: str
    byte_size: int
    state: str
    failure_code: str | None


class Receipt(BaseModel):
    batch_id: str
    album_id: str
    photo_ids: list[str]
    failed_item_ids: list[str]
    album_revision: int


class BatchView(BaseModel):
    id: str
    album_id: str
    album_revision: int
    state: str
    expires_at: datetime
    items: list[ItemView]
    result: Receipt | None


def request_digest(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def item_view(item: UploadItem) -> dict:
    return {
        "id": item.id,
        "item_index": item.item_index,
        "original_filename": item.original_filename,
        "byte_size": item.expected_bytes,
        "state": item.state,
        "failure_code": item.failure_code,
    }


class ImportService:
    def __init__(self, auth: AuthService):
        self.auth = auth
        self.sessions = auth.sessions
        self.settings = auth.settings
        self.lock = threading.RLock()
        # Bounds both multipart spooling and expensive decodes, across all users.
        self.slots = threading.BoundedSemaphore(2)
        with self.sessions.begin() as db:
            db.execute(
                update(UploadItem)
                .where(UploadItem.state == "receiving")
                .values(
                    state="failed", attempt_token=None, lease_until=None, failure_code="INTERRUPTED"
                )
            )

    def batch(self, db, batch_id: str, owner: str) -> ImportBatch:
        batch = db.scalar(
            select(ImportBatch).where(ImportBatch.id == batch_id, ImportBatch.owner_id == owner)
        )
        if batch is None:
            raise not_found()
        return batch

    def ensure_open(self, batch: ImportBatch) -> None:
        if batch.state == "expired" or (
            batch.state == "open" and batch.expires_at <= self.auth.clock()
        ):
            raise ApiError(410, "IMPORT_EXPIRED", "这次导入已过期，请重新选择文件")
        if batch.state != "open":
            raise ApiError(409, "IMPORT_CLOSED", "这次导入已结束，不能继续上传或修改")

    def lock_batch(self, db, batch_id: str, owner: str) -> ImportBatch:
        # Acquire SQLite's write lock BEFORE reads, avoiding snapshot upgrade races.
        db.execute(
            update(ImportBatch)
            .where(ImportBatch.id == batch_id, ImportBatch.owner_id == owner)
            .values(state=ImportBatch.state)
        )
        return self.batch(db, batch_id, owner)

    def view(self, db, batch: ImportBatch) -> dict:
        if batch.state == "open" and batch.expires_at <= self.auth.clock():
            raise ApiError(410, "IMPORT_EXPIRED", "这次导入已过期，请重新选择文件")
        album = db.get(Album, batch.album_id)
        items = db.scalars(
            select(UploadItem)
            .where(UploadItem.batch_id == batch.id, UploadItem.owner_id == batch.owner_id)
            .order_by(UploadItem.item_index)
        ).all()
        return {
            "id": batch.id,
            "album_id": batch.album_id,
            "album_revision": album.revision,
            "state": batch.state,
            "expires_at": datetime.fromtimestamp(batch.expires_at / 1000, UTC),
            "items": [item_view(item) for item in items],
            "result": json.loads(batch.commit_result_json) if batch.commit_result_json else None,
        }

    def create(self, album_id: str, owner: str, key: str, data: ImportInput):
        digest = request_digest({"album_id": album_id, **data.model_dump()})
        with self.lock, self.sessions.begin() as db:
            db.execute(
                update(Album)
                .where(Album.id == album_id, Album.owner_id == owner)
                .values(revision=Album.revision)
            )
            if (
                db.scalar(select(Album.id).where(Album.id == album_id, Album.owner_id == owner))
                is None
            ):
                raise not_found()
            existing = db.scalar(
                select(ImportBatch).where(
                    ImportBatch.owner_id == owner, ImportBatch.request_key == key
                )
            )
            if existing is not None:
                if existing.request_hash != digest:
                    raise ApiError(
                        409, "IDEMPOTENCY_CONFLICT", "同一导入标识对应的文件已改变，请开始新的导入"
                    )
                return self.view(db, existing), False
            now = self.auth.clock()
            batch = ImportBatch(
                id=str(uuid4()),
                owner_id=owner,
                album_id=album_id,
                request_key=key,
                request_hash=digest,
                expected_count=len(data.items),
                created_at=now,
                expires_at=now + DAY,
                state="open",
            )
            db.add(batch)
            db.flush()
            for index, item in enumerate(data.items):
                db.add(
                    UploadItem(
                        id=str(uuid4()),
                        owner_id=owner,
                        batch_id=batch.id,
                        item_index=index,
                        original_filename=item.original_filename,
                        expected_bytes=item.byte_size,
                        expected_sha256=item.sha256,
                        storage_key=uuid4().hex,
                        reserved_photo_id=str(uuid4()),
                        created_at=now,
                        updated_at=now,
                        state="pending",
                    )
                )
            db.flush()
            return self.view(db, batch), True

    def get(self, batch_id: str, owner: str):
        with self.sessions() as db:
            return self.view(db, self.batch(db, batch_id, owner))

    def begin_upload(self, batch_id: str, item_id: str, owner: str):
        with self.lock, self.sessions.begin() as db:
            batch = self.lock_batch(db, batch_id, owner)
            self.ensure_open(batch)
            item = db.scalar(
                select(UploadItem).where(
                    UploadItem.id == item_id,
                    UploadItem.batch_id == batch.id,
                    UploadItem.owner_id == owner,
                )
            )
            if item is None:
                raise not_found()
            if item.state == "staged":
                return item, None
            now = self.auth.clock()
            if item.state == "receiving" and item.lease_until > now:
                raise ApiError(409, "UPLOAD_IN_PROGRESS", "这张图片正在传输，请稍候查询状态")
            if item.state not in {"pending", "failed", "receiving"}:
                raise ApiError(409, "ITEM_CLOSED", "这张图片的上传已结束")
            active = db.scalar(
                select(func.count())
                .select_from(UploadItem)
                .where(
                    UploadItem.batch_id == batch_id,
                    UploadItem.state == "receiving",
                    UploadItem.lease_until > now,
                )
            )
            if active >= 2:
                raise ApiError(
                    429, "UPLOAD_BUSY", "同时最多传输两张图片，请稍后重试", {"Retry-After": "2"}
                )
            item.state, item.attempt_token, item.lease_until = "receiving", uuid4().hex, now + LEASE
            item.updated_at, item.failure_code = now, None
            return item, item.attempt_token

    def receive(self, batch_id: str, item: UploadItem, owner: str, token: str, stream):
        temporary = private_path(self.settings.staging_dir, item.storage_key, token)
        try:
            metadata = write_and_validate(
                stream, temporary, item.expected_bytes, item.expected_sha256
            )
            with self.lock:
                with self.sessions() as db:
                    self.ensure_open(self.batch(db, batch_id, owner))
                    current = db.get(UploadItem, item.id)
                    if (
                        current.state != "receiving"
                        or current.attempt_token != token
                        or current.lease_until <= self.auth.clock()
                    ):
                        raise ApiError(409, "UPLOAD_ATTEMPT_EXPIRED", "这次传输已失效，请重新上传")
                os.replace(temporary, private_path(self.settings.staging_dir, item.storage_key))
                with self.sessions.begin() as db:
                    db.execute(
                        update(UploadItem)
                        .where(UploadItem.id == item.id, UploadItem.attempt_token == token)
                        .values(
                            **metadata,
                            state="staged",
                            attempt_token=None,
                            lease_until=None,
                            failure_code=None,
                            updated_at=self.auth.clock(),
                        )
                    )
            return {**item_view(item), "state": "staged", "failure_code": None}
        finally:
            remove_temporary(temporary)

    def fail_upload(self, item_id: str, token: str, code: str):
        with self.lock, self.sessions.begin() as db:
            db.execute(
                update(UploadItem)
                .where(
                    UploadItem.id == item_id,
                    UploadItem.attempt_token == token,
                    UploadItem.state == "receiving",
                )
                .values(
                    state="failed",
                    attempt_token=None,
                    lease_until=None,
                    failure_code=code,
                    updated_at=self.auth.clock(),
                )
            )

    def commit(self, batch_id: str, owner: str, data: CommitInput):
        digest = request_digest(data.model_dump())
        with self.lock:
            with self.sessions() as db:
                batch = self.batch(db, batch_id, owner)
                if batch.state == "committed":
                    if batch.commit_request_hash != digest:
                        raise ApiError(
                            409, "COMMIT_CONFLICT", "这次导入已按其他参数保存，请查询保存结果"
                        )
                    return json.loads(batch.commit_result_json)
                self.ensure_open(batch)
                items = db.scalars(
                    select(UploadItem)
                    .where(UploadItem.batch_id == batch_id, UploadItem.owner_id == owner)
                    .order_by(UploadItem.item_index)
                ).all()
                staged = [item for item in items if item.state == "staged"]
                failed = [item.id for item in items if item.state != "staged"]
                if any(item.state == "receiving" for item in items):
                    raise ApiError(409, "IMPORT_NOT_READY", "还有图片正在传输，请稍后再保存")
                if not staged or (failed and not data.allow_partial):
                    raise ApiError(409, "IMPORT_NOT_READY", "文件尚未全部校验完成，请先上传或重试")
                album = db.get(Album, batch.album_id)
                if album.revision != data.expected_album_revision:
                    raise ApiError(409, "ALBUM_CHANGED", "影集已有更新，请重新核对后保存")
                album_id = album.id
            # File publication happens outside a DB transaction. If a later DB
            # commit fails, retained originals can be revalidated on retry.
            for item in staged:
                source = private_path(self.settings.staging_dir, item.storage_key)
                target = private_path(self.settings.originals_dir, item.storage_key)
                available = target if target.exists() else source
                if not matches(available, item.actual_bytes, item.sha256):
                    raise ApiError(
                        503,
                        "STAGED_FILE_UNAVAILABLE",
                        "待保存的图片缺失或校验失败，请取消后重新选择",
                    )
                if available == source:
                    os.replace(source, target)
            with self.sessions.begin() as db:
                batch = self.lock_batch(db, batch_id, owner)
                self.ensure_open(batch)
                new_revision = db.scalar(
                    update(Album)
                    .where(
                        Album.id == album_id,
                        Album.owner_id == owner,
                        Album.revision == data.expected_album_revision,
                    )
                    .values(revision=Album.revision + 1, updated_at=self.auth.clock())
                    .returning(Album.revision)
                )
                if new_revision is None:
                    raise ApiError(409, "ALBUM_CHANGED", "影集已有更新，请重新核对后保存")
                position = (
                    db.scalar(
                        select(func.coalesce(func.max(Photo.position), -1)).where(
                            Photo.album_id == album_id,
                            Photo.owner_id == owner,
                            Photo.state == "active",
                        )
                    )
                    + 1
                )
                now = self.auth.clock()
                for index, item in enumerate(staged):
                    db.add(
                        Photo(
                            id=item.reserved_photo_id,
                            owner_id=owner,
                            album_id=album_id,
                            upload_item_id=item.id,
                            storage_key=item.storage_key,
                            original_filename=item.original_filename,
                            mime_type=item.mime_type,
                            byte_size=item.actual_bytes,
                            sha256=item.sha256,
                            width=item.width,
                            height=item.height,
                            position=position + index,
                            state="active",
                            revision=1,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    db.execute(
                        update(UploadItem)
                        .where(UploadItem.id == item.id)
                        .values(state="committed", updated_at=now)
                    )
                if failed:
                    db.execute(
                        update(UploadItem)
                        .where(UploadItem.id.in_(failed))
                        .values(
                            state="discarded", attempt_token=None, lease_until=None, updated_at=now
                        )
                    )
                result = {
                    "batch_id": batch_id,
                    "album_id": album_id,
                    "photo_ids": [item.reserved_photo_id for item in staged],
                    "failed_item_ids": failed,
                    "album_revision": new_revision,
                }
                batch.state, batch.committed_at = "committed", now
                batch.commit_request_hash, batch.commit_result_json = digest, json.dumps(result)
            return result

    def cancel(self, batch_id: str, owner: str):
        with self.lock:
            with self.sessions.begin() as db:
                batch = self.lock_batch(db, batch_id, owner)
                if batch.state == "committed":
                    raise ApiError(
                        409, "IMPORT_COMMITTED", "图片已加入影集，不能作为待完成导入取消"
                    )
                batch.state = "expired" if batch.expires_at <= self.auth.clock() else "canceled"
                items = db.scalars(
                    select(UploadItem).where(
                        UploadItem.batch_id == batch_id, UploadItem.owner_id == owner
                    )
                ).all()
                for item in items:
                    item.state, item.attempt_token, item.lease_until = "discarded", None, None
            # Only this batch's unpublished files; receipt/metadata remain.
            for item in items:
                remove_temporary(private_path(self.settings.staging_dir, item.storage_key))
                with self.sessions() as db:
                    referenced = db.scalar(
                        select(Photo.id).where(Photo.storage_key == item.storage_key).limit(1)
                    )
                if referenced is None:
                    remove_temporary(private_path(self.settings.originals_dir, item.storage_key))


@router.post(
    "/albums/{album_id}/imports",
    status_code=201,
    response_model=Envelope[BatchView],
    responses={200: {"model": Envelope[BatchView]}},
)
def create_import(
    album_id: str,
    data: ImportInput,
    request: Request,
    response: Response,
    user: CurrentUser,
    idempotency_key: Annotated[str, Header(pattern=r"^[A-Za-z0-9_-]{1,128}$")],
):
    result, created = request.app.state.imports.create(album_id, user.id, idempotency_key, data)
    response.status_code = 201 if created else 200
    return {"data": result}


@router.get("/imports/{batch_id}", response_model=Envelope[BatchView])
def import_status(batch_id: str, request: Request, user: CurrentUser):
    return {"data": request.app.state.imports.get(batch_id, user.id)}


@router.put("/imports/{batch_id}/items/{item_id}/content", response_model=Envelope[ItemView])
async def upload_content(batch_id: str, item_id: str, request: Request, user: CurrentUser):
    service: ImportService = request.app.state.imports
    # Ownership/state checks happen before request.form() reads a single byte.
    item, token = await run_in_threadpool(service.begin_upload, batch_id, item_id, user.id)
    if token is None:
        return {"data": item_view(item)}
    acquired = service.slots.acquire(blocking=False)
    try:
        if not acquired:
            raise ApiError(
                429, "UPLOAD_BUSY", "目前正在处理其他图片，请稍后重试", {"Retry-After": "2"}
            )
        if not request.headers.get("content-type", "").lower().startswith("multipart/form-data;"):
            raise ApiError(415, "MULTIPART_REQUIRED", "请以单个文件上传图片")

        async def limited_stream():
            received = 0
            async for chunk in request.stream():
                received += len(chunk)
                if received > min(item.expected_bytes, MAX_FILE_BYTES) + MULTIPART_OVERHEAD:
                    raise ApiError(413, "REQUEST_TOO_LARGE", "上传内容超过允许大小")
                yield chunk

        # Starlette closes spooled files on any parser/read error. Restrict parts
        # to one file and no text fields; do not use auto-parsed FastAPI File().
        parser = BoundedMultipartParser(
            request.headers,
            limited_stream(),
            max_files=1,
            max_fields=0,
            max_part_size=MULTIPART_OVERHEAD,
        )
        form = await parser.parse()
        try:
            file = form.get("file")
            if len(form.multi_items()) != 1 or not isinstance(file, UploadFile):
                raise ApiError(422, "FILE_REQUIRED", "请选择一个图片文件")
            return {
                "data": await run_in_threadpool(
                    service.receive, batch_id, item, user.id, token, file.file
                )
            }
        finally:
            await form.close()
    except BaseException as exc:
        code = exc.code if isinstance(exc, ApiError) else "UPLOAD_FAILED"
        await run_in_threadpool(service.fail_upload, item_id, token, code)
        if isinstance(exc, ClientDisconnect):
            raise ApiError(400, "UPLOAD_INTERRUPTED", "传输已中断，可重新上传") from exc
        if isinstance(exc, (HTTPException, MultiPartException, MultipartParseError)):
            raise ApiError(422, "INVALID_MULTIPART", "上传格式不正确，请重新选择文件") from exc
        raise
    finally:
        if acquired:
            service.slots.release()


@router.post("/imports/{batch_id}/commit", response_model=Envelope[Receipt])
def commit_import(batch_id: str, data: CommitInput, request: Request, user: CurrentUser):
    return {"data": request.app.state.imports.commit(batch_id, user.id, data)}


@router.delete("/imports/{batch_id}", status_code=204)
def cancel_import(batch_id: str, request: Request, user: CurrentUser):
    request.app.state.imports.cancel(batch_id, user.id)


@router.get("/photos/{photo_id}/original")
def original(photo_id: str, request: Request, user: CurrentUser):
    service: ImportService = request.app.state.imports
    with service.sessions() as db:
        photo = db.scalar(
            select(Photo).where(
                Photo.id == photo_id, Photo.owner_id == user.id, Photo.state == "active"
            )
        )
        if photo is None:
            raise not_found()
    path = private_path(service.settings.originals_dir, photo.storage_key)
    if not path.is_file() or path.stat().st_size != photo.byte_size:
        raise ApiError(503, "ORIGINAL_UNAVAILABLE", "原图暂时无法读取，请检查本机数据存储")
    return FileResponse(
        path,
        media_type=photo.mime_type,
        filename=photo.original_filename,
        content_disposition_type="inline",
    )
