"""Read-only photo browsing with account- and album-version-bound pagination."""

from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select

from city_memories.albums import Cursor, Envelope, Limit, decode_cursor, encode_cursor, not_found
from city_memories.auth import CurrentUser
from city_memories.errors import ApiError
from city_memories.models import Album, Photo

router = APIRouter(prefix="/api/v1", tags=["photos"])


class PhotoView(BaseModel):
    id: str
    album_id: str
    original_filename: str
    mime_type: str
    byte_size: int
    width: int
    height: int
    position: int
    revision: int
    has_note: bool
    original_url: str


class PhotoPage(BaseModel):
    items: list[PhotoView]
    next_cursor: str | None
    album_revision: int
    photo_count: int


class PhotoDetail(PhotoView):
    note: str
    album_revision: int
    previous_photo_id: str | None
    next_photo_id: str | None
    ordinal: int
    photo_count: int


def photo_view(photo: Photo) -> dict:
    return {
        "id": photo.id,
        "album_id": photo.album_id,
        "original_filename": photo.original_filename,
        "mime_type": photo.mime_type,
        "byte_size": photo.byte_size,
        "width": photo.width,
        "height": photo.height,
        "position": photo.position,
        "revision": photo.revision,
        "has_note": bool(photo.note),
        "original_url": f"/api/v1/photos/{photo.id}/original",
    }


def changed() -> ApiError:
    return ApiError(409, "ALBUM_CHANGED", "影集已有更新，请重新核对照片列表")


@router.get("/albums/{album_id}/photos", response_model=Envelope[PhotoPage])
def photos(
    album_id: str, request: Request, user: CurrentUser, cursor: Cursor = None, limit: Limit = 24
):
    scope = f"photos:{user.id}:{album_id}"
    with request.app.state.auth.sessions() as db:
        # Authorization, version, count and rows share one consistent read snapshot.
        album = db.scalar(select(Album).where(Album.id == album_id, Album.owner_id == user.id))
        if album is None:
            raise not_found()
        keys = decode_cursor(request, cursor, scope)
        condition = (Photo.album_id == album_id, Photo.owner_id == user.id, Photo.state == "active")
        query = select(Photo).where(*condition)
        if keys is not None:
            revision, last = keys
            if (
                type(revision) is not int
                or revision < 1
                or not isinstance(last, list)
                or len(last) != 2
                or type(last[0]) is not int
                or last[0] < 0
                or not isinstance(last[1], str)
            ):
                raise ApiError(422, "INVALID_CURSOR", "列表位置已失效，请重新加载")
            if revision != album.revision:
                raise changed()
            query = query.where(
                or_(Photo.position > last[0], and_(Photo.position == last[0], Photo.id > last[1]))
            )
        rows = db.scalars(query.order_by(Photo.position, Photo.id).limit(limit + 1)).all()
        items = rows[:limit]
        next_cursor = (
            encode_cursor(request, scope, [album.revision, [items[-1].position, items[-1].id]])
            if len(rows) > limit
            else None
        )
        return {
            "data": {
                "items": [photo_view(photo) for photo in items],
                "next_cursor": next_cursor,
                "album_revision": album.revision,
                "photo_count": db.scalar(select(func.count()).select_from(Photo).where(*condition)),
            }
        }


@router.get("/photos/{photo_id}", response_model=Envelope[PhotoDetail])
def photo_detail(
    photo_id: str,
    request: Request,
    user: CurrentUser,
    album_id: Annotated[str | None, Query(max_length=36)] = None,
    expected_album_revision: Annotated[int | None, Query(ge=1)] = None,
):
    with request.app.state.auth.sessions() as db:
        photo = db.scalar(
            select(Photo).where(
                Photo.id == photo_id, Photo.owner_id == user.id, Photo.state == "active"
            )
        )
        if photo is None:
            raise not_found()
        album = db.get(Album, photo.album_id)
        if (album_id is not None and photo.album_id != album_id) or (
            expected_album_revision is not None and album.revision != expected_album_revision
        ):
            raise changed()
        condition = (
            Photo.album_id == photo.album_id,
            Photo.owner_id == user.id,
            Photo.state == "active",
        )
        previous = db.scalar(
            select(Photo.id)
            .where(*condition, Photo.position < photo.position)
            .order_by(Photo.position.desc())
            .limit(1)
        )
        following = db.scalar(
            select(Photo.id)
            .where(*condition, Photo.position > photo.position)
            .order_by(Photo.position)
            .limit(1)
        )
        return {
            "data": {
                **photo_view(photo),
                "note": photo.note,
                "album_revision": album.revision,
                "previous_photo_id": previous,
                "next_photo_id": following,
                "ordinal": db.scalar(
                    select(func.count())
                    .select_from(Photo)
                    .where(*condition, Photo.position <= photo.position)
                ),
                "photo_count": db.scalar(select(func.count()).select_from(Photo).where(*condition)),
            }
        }
