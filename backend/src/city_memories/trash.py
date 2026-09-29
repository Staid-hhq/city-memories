"""Thirty-day soft deletion and restoration. No physical cleanup runs here."""

import hashlib
import json

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select, update

from city_memories.albums import (
    CityView,
    Cursor,
    Envelope,
    Limit,
    city_view,
    decode_cursor,
    encode_cursor,
    not_found,
)
from city_memories.auth import CurrentUser
from city_memories.errors import ApiError
from city_memories.imports import original_response
from city_memories.models import Album, City, Photo
from city_memories.photos import PhotoView, changed, photo_view

router = APIRouter(prefix="/api/v1", tags=["trash"])
RETENTION_MS = 30 * 24 * 60 * 60 * 1000


class VersionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_photo_revision: int = Field(strict=True, ge=1)
    expected_album_revision: int = Field(strict=True, ge=1)


class TrashView(BaseModel):
    id: str
    album_id: str
    city: CityView
    year: int | None
    original_filename: str
    mime_type: str
    byte_size: int
    width: int
    height: int
    revision: int
    album_revision: int
    has_note: bool
    deleted_at: int
    purge_after: int
    remaining_ms: int
    original_url: str


class TrashDetail(TrashView):
    note: str


class TrashPage(BaseModel):
    items: list[TrashView]
    next_cursor: str | None
    photo_count: int
    server_time: int


class RestoredView(BaseModel):
    photo: PhotoView
    album_revision: int
    duplicate_count: int


def require_trashed(photo: Photo | None, now: int):
    if photo is None:
        raise not_found()
    if photo.state == "purging" or (photo.state == "trashed" and photo.purge_after <= now):
        raise ApiError(410, "TRASH_EXPIRED", "这张照片已超过保留期限，不能再查看或恢复")
    if photo.state != "trashed":
        raise ApiError(409, "PHOTO_NOT_TRASHED", "照片已不在回收站，请核对当前状态")


def owned_photo(db, photo_id: str, owner: str, *, lock: bool = False):
    if lock:
        # Serialize before reading state, revisions and the current server clock.
        db.execute(
            update(Photo)
            .where(Photo.id == photo_id, Photo.owner_id == owner)
            .values(revision=Photo.revision)
        )
    return db.scalar(select(Photo).where(Photo.id == photo_id, Photo.owner_id == owner))


def trash_view(photo: Photo, album: Album, city: City, now: int):
    return {
        **photo_view(photo),
        "city": city_view(city),
        "year": album.year,
        "album_revision": album.revision,
        "deleted_at": photo.deleted_at,
        "purge_after": photo.purge_after,
        "remaining_ms": max(0, photo.purge_after - now),
        "original_url": f"/api/v1/trash/photos/{photo.id}/original",
    }


@router.post("/photos/{photo_id}/trash", response_model=Envelope[TrashDetail])
def trash_photo(photo_id: str, data: VersionInput, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions.begin() as db:
        photo = owned_photo(db, photo_id, user.id, lock=True)
        if photo is None:
            raise not_found()
        if photo.state != "active" or photo.revision != data.expected_photo_revision:
            raise ApiError(409, "PHOTO_CHANGED", "照片文字、归属或状态已有更新，请核对后再删除")
        album = db.get(Album, photo.album_id)
        if album.revision != data.expected_album_revision:
            raise changed()
        now = request.app.state.auth.clock()
        photo.state = "trashed"
        photo.position = None
        photo.deleted_at = now
        photo.purge_after = now + RETENTION_MS
        photo.revision += 1
        photo.updated_at = now
        album.revision += 1
        album.updated_at = now
        db.flush()
        return {
            "data": {
                **trash_view(photo, album, db.get(City, album.city_id), now),
                "note": photo.note,
            }
        }


@router.get("/trash/photos", response_model=Envelope[TrashPage])
def trash_photos(request: Request, user: CurrentUser, cursor: Cursor = None, limit: Limit = 24):
    scope = f"trash:{user.id}"
    with request.app.state.auth.sessions() as db:
        now = request.app.state.auth.clock()
        condition = (Photo.owner_id == user.id, Photo.state == "trashed", Photo.purge_after > now)
        # A compact metadata fingerprint invalidates pages after restore/re-delete
        # or expiry, without a new table or exposing any original-file hash.
        members = db.execute(
            select(Photo.id, Photo.revision).where(*condition).order_by(Photo.id)
        ).all()
        snapshot = hashlib.sha256(json.dumps([list(row) for row in members]).encode()).hexdigest()
        query = (
            select(Photo, Album, City)
            .join(Album, Photo.album_id == Album.id)
            .join(City, Album.city_id == City.id)
            .where(*condition, Album.owner_id == user.id)
        )
        keys = decode_cursor(request, cursor, scope)
        if keys is not None:
            version, last = keys
            if (
                not isinstance(version, str)
                or not isinstance(last, list)
                or len(last) != 2
                or type(last[0]) is not int
                or last[0] < 0
                or not isinstance(last[1], str)
            ):
                raise ApiError(422, "INVALID_CURSOR", "列表位置已失效，请重新加载")
            if version != snapshot:
                raise ApiError(409, "TRASH_CHANGED", "回收站内容或保留期限已有变化，请重新加载")
            query = query.where(
                or_(
                    Photo.deleted_at < last[0],
                    and_(Photo.deleted_at == last[0], Photo.id > last[1]),
                )
            )
        rows = db.execute(query.order_by(Photo.deleted_at.desc(), Photo.id).limit(limit + 1)).all()
        items = rows[:limit]
        next_cursor = (
            encode_cursor(
                request,
                scope,
                [
                    snapshot,
                    [items[-1][0].deleted_at, items[-1][0].id],
                ],
            )
            if len(rows) > limit
            else None
        )
        return {
            "data": {
                "items": [trash_view(p, a, c, now) for p, a, c in items],
                "next_cursor": next_cursor,
                "photo_count": len(members),
                "server_time": now,
            }
        }


@router.get("/trash/photos/{photo_id}", response_model=Envelope[TrashDetail])
def trash_detail(photo_id: str, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions() as db:
        photo = owned_photo(db, photo_id, user.id)
        now = request.app.state.auth.clock()
        require_trashed(photo, now)
        album = db.get(Album, photo.album_id)
        return {
            "data": {
                **trash_view(photo, album, db.get(City, album.city_id), now),
                "note": photo.note,
            }
        }


@router.get("/trash/photos/{photo_id}/original")
def trash_original(photo_id: str, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions() as db:
        photo = owned_photo(db, photo_id, user.id)
        require_trashed(photo, request.app.state.auth.clock())
        return original_response(photo, request)


@router.post("/trash/photos/{photo_id}/restore", response_model=Envelope[RestoredView])
def restore_photo(photo_id: str, data: VersionInput, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions.begin() as db:
        photo = owned_photo(db, photo_id, user.id, lock=True)
        now = request.app.state.auth.clock()
        require_trashed(photo, now)
        if photo.revision != data.expected_photo_revision:
            raise ApiError(409, "PHOTO_CHANGED", "照片状态已有更新，请核对后再恢复")
        album = db.get(Album, photo.album_id)
        if album.revision != data.expected_album_revision:
            raise changed()
        # Check availability before making a row visible again; never rewrite bytes.
        original_response(photo, request)
        condition = (Photo.owner_id == user.id, Photo.album_id == album.id, Photo.state == "active")
        last = db.scalar(select(func.max(Photo.position)).where(*condition))
        duplicates = db.scalar(
            select(func.count()).select_from(Photo).where(*condition, Photo.sha256 == photo.sha256)
        )
        photo.state = "active"
        photo.position = 0 if last is None else last + 1
        photo.deleted_at = None
        photo.purge_after = None
        photo.revision += 1
        photo.updated_at = now
        album.revision += 1
        album.updated_at = now
        db.flush()
        return {
            "data": {
                "photo": photo_view(photo),
                "album_revision": album.revision,
                "duplicate_count": duplicates + 1 if duplicates else 0,
            }
        }
