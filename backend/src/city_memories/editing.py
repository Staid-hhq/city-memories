"""Version-checked notes and complete-album ordering; never rewrites originals."""

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update

from city_memories.albums import Envelope, not_found
from city_memories.auth import CurrentUser
from city_memories.errors import ApiError
from city_memories.models import Album, Photo
from city_memories.photos import changed

router = APIRouter(prefix="/api/v1", tags=["photo-editing"])


class NoteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str = Field(strict=True, max_length=2000)
    expected_photo_revision: int = Field(strict=True, ge=1)

    @field_validator("note")
    @classmethod
    def valid_unicode(cls, value: str) -> str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("文字包含不完整的 Unicode 字符") from error
        return value


class NoteView(BaseModel):
    id: str
    album_id: str
    note: str
    revision: int
    has_note: bool


class ReorderInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    photo_id: str = Field(min_length=1, max_length=36)
    before_photo_id: str | None = Field(min_length=1, max_length=36)
    expected_album_revision: int = Field(strict=True, ge=1)


class OrderView(BaseModel):
    album_id: str
    photo_id: str
    before_photo_id: str | None
    album_revision: int
    changed: bool


@router.patch("/photos/{photo_id}/note", response_model=Envelope[NoteView])
def save_note(photo_id: str, data: NoteInput, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions.begin() as db:
        # Serialize writers before reading, including independent app connections.
        db.execute(
            update(Photo)
            .where(Photo.id == photo_id, Photo.owner_id == user.id, Photo.state == "active")
            .values(revision=Photo.revision)
        )
        photo = db.scalar(
            select(Photo).where(
                Photo.id == photo_id, Photo.owner_id == user.id, Photo.state == "active"
            )
        )
        if photo is None:
            raise not_found()
        if photo.revision != data.expected_photo_revision:
            raise ApiError(409, "PHOTO_CHANGED", "照片文字或状态已有更新，请核对最新内容后再保存")
        if photo.note != data.note:
            photo.note = data.note
            photo.revision += 1
            photo.updated_at = request.app.state.auth.clock()
        return {"data": {
            "id": photo.id, "album_id": photo.album_id, "note": photo.note,
            "revision": photo.revision, "has_note": bool(photo.note),
        }}


@router.post("/albums/{album_id}/reorder", response_model=Envelope[OrderView])
def reorder(album_id: str, data: ReorderInput, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions.begin() as db:
        # The SQLite writer lock precedes all reads, not just the final CAS.
        db.execute(
            update(Album)
            .where(Album.id == album_id, Album.owner_id == user.id)
            .values(revision=Album.revision)
        )
        album = db.scalar(select(Album).where(Album.id == album_id, Album.owner_id == user.id))
        if album is None:
            raise not_found()
        rows = db.execute(
            select(Photo.id, Photo.position)
            .where(Photo.album_id == album_id, Photo.owner_id == user.id, Photo.state == "active")
            .order_by(Photo.position, Photo.id)
        ).all()
        old_ids = [row.id for row in rows]
        if data.photo_id not in old_ids or (
            data.before_photo_id is not None and data.before_photo_id not in old_ids
        ):
            raise not_found()
        if album.revision != data.expected_album_revision:
            raise changed()
        new_ids = old_ids.copy()
        if data.before_photo_id != data.photo_id:
            new_ids.remove(data.photo_id)
            index = len(new_ids) if data.before_photo_id is None else new_ids.index(
                data.before_photo_id
            )
            new_ids.insert(index, data.photo_id)
        did_change = new_ids != old_ids
        if did_change:
            # Move all active positions above the old maximum before assigning
            # compact positions. Both passes and the revision are one transaction.
            # Photo revisions/notes/bytes do not change for a pure reorder.
            base = max(row.position for row in rows) + 1
            for offset, photo in enumerate(old_ids):
                db.execute(update(Photo).where(Photo.id == photo).values(position=base + offset))
            for position, photo in enumerate(new_ids):
                db.execute(update(Photo).where(Photo.id == photo).values(position=position))
            album.revision += 1
            album.updated_at = request.app.state.auth.clock()
        return {"data": {
            "album_id": album_id, "photo_id": data.photo_id,
            "before_photo_id": data.before_photo_id, "album_revision": album.revision,
            "changed": did_change,
        }}
