"""Atomic cross-album moves and bounded, account-private duplicate browsing."""

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select, update

from city_memories.albums import Cursor, Envelope, Limit, decode_cursor, encode_cursor, not_found
from city_memories.auth import CurrentUser
from city_memories.errors import ApiError
from city_memories.models import Album, Photo
from city_memories.photos import PhotoView, changed, photo_view

router = APIRouter(prefix="/api/v1", tags=["photo-organizing"])


class MoveInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_album_id: str = Field(strict=True, min_length=1, max_length=36)
    expected_photo_revision: int = Field(strict=True, ge=1)
    expected_source_revision: int = Field(strict=True, ge=1)
    expected_target_revision: int = Field(strict=True, ge=1)


class MoveView(BaseModel):
    photo: PhotoView
    source_album_id: str
    source_revision: int
    target_album_id: str
    target_revision: int
    target_duplicate_count: int


@router.post("/photos/{photo_id}/move", response_model=Envelope[MoveView])
def move_photo(photo_id: str, data: MoveInput, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions.begin() as db:
        # Acquire the SQLite writer lock before reading any version or membership.
        db.execute(update(Photo).where(
            Photo.id == photo_id, Photo.owner_id == user.id, Photo.state == "active"
        ).values(revision=Photo.revision))
        photo = db.scalar(select(Photo).where(
            Photo.id == photo_id, Photo.owner_id == user.id, Photo.state == "active"
        ))
        target = db.scalar(select(Album).where(
            Album.id == data.target_album_id, Album.owner_id == user.id
        ))
        if photo is None or target is None:
            raise not_found()
        source = db.scalar(select(Album).where(
            Album.id == photo.album_id, Album.owner_id == user.id
        ))
        if source is None:
            raise not_found()
        if photo.revision != data.expected_photo_revision:
            raise ApiError(409, "PHOTO_CHANGED", "照片已有更新或移动，请重新核对当前位置和文字")
        if source.id == target.id:
            raise ApiError(409, "SAME_ALBUM", "照片已在这个影集中；调整顺序请使用影集内排序")
        if source.revision != data.expected_source_revision:
            raise ApiError(409, "SOURCE_CHANGED", "原影集已有更新，请重新核对后再移动")
        if target.revision != data.expected_target_revision:
            raise ApiError(409, "TARGET_CHANGED", "目标影集已有更新，请重新核对后再移动")
        condition = (
            Photo.owner_id == user.id, Photo.album_id == target.id, Photo.state == "active"
        )
        last = db.scalar(select(func.max(Photo.position)).where(*condition))
        duplicates = db.scalar(select(func.count()).select_from(Photo).where(
            *condition, Photo.sha256 == photo.sha256
        ))
        now = request.app.state.auth.clock()
        photo.album_id = target.id
        photo.position = 0 if last is None else last + 1
        photo.revision += 1
        photo.updated_at = now
        source.revision += 1
        source.updated_at = now
        target.revision += 1
        target.updated_at = now
        # Source positions may have gaps: order, not contiguous numbering, is the
        # invariant. IDs, notes, upload receipts and storage keys stay untouched.
        db.flush()
        return {"data": {
            "photo": photo_view(photo), "source_album_id": source.id,
            "source_revision": source.revision, "target_album_id": target.id,
            "target_revision": target.revision,
            "target_duplicate_count": duplicates + 1 if duplicates else 0,
        }}


class DuplicateGroup(BaseModel):
    group_id: str
    total: int
    photos: list[PhotoView]


class DuplicatePage(BaseModel):
    items: list[DuplicateGroup]
    next_cursor: str | None
    album_revision: int
    group_count: int
    photo_count: int


@router.get("/albums/{album_id}/duplicates", response_model=Envelope[DuplicatePage])
def duplicates(
    album_id: str, request: Request, user: CurrentUser, cursor: Cursor = None, limit: Limit = 24
):
    scope = f"duplicates:{user.id}:{album_id}"
    condition = (Photo.owner_id == user.id, Photo.album_id == album_id, Photo.state == "active")
    # The public group ID is a representative photo UUID, never a content hash.
    groups = select(
        Photo.sha256.label("digest"), func.min(Photo.id).label("group_id"),
        func.count().label("total"),
    ).where(*condition).group_by(Photo.sha256).having(func.count() > 1).subquery()
    with request.app.state.auth.sessions() as db:
        album = db.scalar(select(Album).where(Album.id == album_id, Album.owner_id == user.id))
        if album is None:
            raise not_found()
        keys = decode_cursor(request, cursor, scope)
        query = select(Photo, groups.c.group_id, groups.c.total).join(
            groups, Photo.sha256 == groups.c.digest
        ).where(*condition)
        if keys is not None:
            revision, last = keys
            if (type(revision) is not int or revision < 1 or not isinstance(last, list)
                    or len(last) != 3 or not isinstance(last[0], str)
                    or type(last[1]) is not int or last[1] < 0 or not isinstance(last[2], str)):
                raise ApiError(422, "INVALID_CURSOR", "列表位置已失效，请重新加载")
            if revision != album.revision:
                raise changed()
            query = query.where(or_(
                groups.c.group_id > last[0],
                and_(groups.c.group_id == last[0], Photo.position > last[1]),
                and_(groups.c.group_id == last[0], Photo.position == last[1], Photo.id > last[2]),
            ))
        rows = db.execute(query.order_by(
            groups.c.group_id, Photo.position, Photo.id
        ).limit(limit + 1)).all()
        page = rows[:limit]
        items = []
        for photo, group_id, total in page:
            if not items or items[-1]["group_id"] != group_id:
                items.append({"group_id": group_id, "total": total, "photos": []})
            items[-1]["photos"].append(photo_view(photo))
        next_cursor = None
        if len(rows) > limit:
            photo, group_id, _ = page[-1]
            next_cursor = encode_cursor(request, scope, [
                album.revision, [group_id, photo.position, photo.id],
            ])
        count, total = db.execute(select(
            func.count(), func.coalesce(func.sum(groups.c.total), 0)
        ).select_from(groups)).one()
        return {"data": {
            "items": items, "next_cursor": next_cursor, "album_revision": album.revision,
            "group_count": count, "photo_count": total,
        }}
