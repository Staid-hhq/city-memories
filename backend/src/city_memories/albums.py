"""Account-scoped city/year albums; no client-provided owner identity is trusted."""

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, case, func, literal, or_, select, update
from sqlalchemy.dialects.sqlite import insert

from city_memories.auth import CurrentUser
from city_memories.errors import ApiError
from city_memories.models import Album, City, Photo

router = APIRouter(prefix="/api/v1", tags=["albums"])
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=1024)]


class CreateAlbum(BaseModel):
    model_config = ConfigDict(extra="forbid")
    year: Annotated[int, Field(strict=True, ge=1, le=9999)] | None


class CoverInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    photo_id: Annotated[str, Field(strict=True, min_length=1, max_length=36)] | None
    expected_revision: Annotated[int, Field(strict=True, ge=1)]


class Envelope[T](BaseModel):
    data: T


class CityView(BaseModel):
    id: str
    name: str
    parent_name: str | None
    unit_kind: str
    can_create: bool


class AlbumView(BaseModel):
    id: str
    city: CityView
    year: int | None
    revision: int
    photo_count: int
    cover_photo_id: str | None
    original_url: str | None
    created_at: datetime
    updated_at: datetime


class PageData[T](BaseModel):
    items: list[T]
    next_cursor: str | None


class AlbumOptions(BaseModel):
    years: list[int | None]


class CityAlbumView(BaseModel):
    city: CityView
    album_count: int
    photo_count: int
    latest_year: int | None
    has_unmarked: bool
    cover_photo_id: str | None
    original_url: str | None


class CityAlbums(PageData[AlbumView]):
    city: CityView


class CreatedAlbum(AlbumView):
    created: bool


class AtlasCity(BaseModel):
    city: CityView
    album_count: int
    photo_count: int
    lit: bool


class AtlasView(BaseModel):
    items: list[AtlasCity]
    album_count: int
    photo_count: int


def city_view(city: City) -> dict:
    return {
        "id": city.id,
        "name": city.name,
        "parent_name": city.parent_name,
        "unit_kind": city.unit_kind,
        "can_create": city.is_active == 1 and city.mapping_status == "verified",
    }


def album_cover(owner_id: str):
    # Preferences remain valid only while this owner's photo is active in the album.
    automatic_cover = (
        select(Photo.id)
        .where(Photo.album_id == Album.id, Photo.owner_id == owner_id, Photo.state == "active")
        .order_by(Photo.position, Photo.id)
        .limit(1)
        .correlate(Album)
        .scalar_subquery()
    )
    preferred_cover = (
        select(Photo.id)
        .where(
            Photo.id == Album.preferred_cover_photo_id,
            Photo.album_id == Album.id,
            Photo.owner_id == owner_id,
            Photo.state == "active",
        )
        .correlate(Album)
        .scalar_subquery()
    )
    return func.coalesce(preferred_cover, automatic_cover)


def album_query(owner_id: str):
    # Correlated, indexed subqueries count only the owner's active photos.
    count = (
        select(func.count(Photo.id))
        .where(Photo.album_id == Album.id, Photo.owner_id == owner_id, Photo.state == "active")
        .correlate(Album)
        .scalar_subquery()
    )
    cover = album_cover(owner_id)
    return (
        select(Album, City, count, cover)
        .join(City, Album.city_id == City.id)
        .where(Album.owner_id == owner_id)
    )


def album_view(row) -> dict:
    album, city, count, cover = row
    return {
        "id": album.id,
        "city": city_view(city),
        "year": album.year,
        "revision": album.revision,
        "photo_count": count,
        "cover_photo_id": cover,
        "original_url": f"/api/v1/photos/{cover}/original" if cover else None,
        "created_at": datetime.fromtimestamp(album.created_at / 1000, UTC),
        "updated_at": datetime.fromtimestamp(album.updated_at / 1000, UTC),
    }


def not_found() -> ApiError:
    return ApiError(404, "NOT_FOUND", "请求的内容不存在")


def encode_cursor(request: Request, scope: str, keys: list) -> str:
    payload = base64.urlsafe_b64encode(json.dumps([scope, keys], ensure_ascii=False).encode())
    signature = hmac.new(request.app.state.auth.secret, payload, hashlib.sha256).hexdigest()
    return payload.decode() + "." + signature


def decode_cursor(request: Request, cursor: str | None, scope: str) -> list | None:
    if cursor is None:
        return None
    try:
        payload, signature = cursor.rsplit(".", 1)
        expected = hmac.new(
            request.app.state.auth.secret, payload.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature.encode(), expected.encode()):
            raise ValueError
        saved_scope, keys = json.loads(base64.urlsafe_b64decode(payload))
        if saved_scope != scope or not isinstance(keys, list) or len(keys) != 2:
            raise ValueError
        return keys
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ApiError(422, "INVALID_CURSOR", "列表位置已失效，请重新加载") from exc


@router.get("/cities", response_model=Envelope[PageData[CityView]])
def cities(
    request: Request,
    user: CurrentUser,
    q: Annotated[str, Query(max_length=80)] = "",
    cursor: Cursor = None,
    limit: Limit = 24,
):
    q = q.strip()
    scope = f"cities:{q}"
    keys = decode_cursor(request, cursor, scope)
    query = select(City).where(City.is_active == 1, City.mapping_status == "verified")
    if q:
        query = query.where(
            or_(
                City.name.contains(q, autoescape=True),
                City.parent_name.contains(q, autoescape=True),
            )
        )
    if keys:
        query = query.where(or_(City.name > keys[0], and_(City.name == keys[0], City.id > keys[1])))
    with request.app.state.auth.sessions() as db:
        rows = db.scalars(query.order_by(City.name, City.id).limit(limit + 1)).all()
    items = rows[:limit]
    next_cursor = (
        encode_cursor(request, scope, [items[-1].name, items[-1].id]) if len(rows) > limit else None
    )
    return {"data": {"items": [city_view(city) for city in items], "next_cursor": next_cursor}}


@router.get("/me/atlas", response_model=Envelope[AtlasView])
def atlas(request: Request, user: CurrentUser):
    # One grouped query per resource type; zero-photo albums remain visible.
    albums = (
        select(Album.city_id, func.count().label("album_count"))
        .where(Album.owner_id == user.id)
        .group_by(Album.city_id)
        .subquery()
    )
    photos = (
        select(Album.city_id, func.count(Photo.id).label("photo_count"))
        .join(
            Photo,
            and_(Photo.album_id == Album.id, Photo.owner_id == user.id, Photo.state == "active"),
        )
        .where(Album.owner_id == user.id)
        .group_by(Album.city_id)
        .subquery()
    )
    with request.app.state.auth.sessions() as db:
        rows = db.execute(
            select(City, albums.c.album_count, func.coalesce(photos.c.photo_count, 0))
            .join(albums, albums.c.city_id == City.id)
            .outerjoin(photos, photos.c.city_id == City.id)
            .order_by(City.name, City.id)
        ).all()
    items = [
        {
            "city": city_view(city),
            "album_count": count,
            "photo_count": photo_count,
            "lit": photo_count > 0,
        }
        for city, count, photo_count in rows
    ]
    return {
        "data": {
            "items": items,
            "album_count": sum(item["album_count"] for item in items),
            "photo_count": sum(item["photo_count"] for item in items),
        }
    }


@router.get("/me/albums", response_model=Envelope[PageData[AlbumView]])
def my_albums(
    request: Request, user: CurrentUser, cursor: Cursor = None, limit: Limit = 24,
    sort: Literal["year", "recent"] = "year",
    q: Annotated[str, Query(max_length=80)] = "",
    year: Annotated[str | None, Query(pattern=r"^(?:unmarked|[1-9][0-9]{0,3})$")] = None,
):
    q = q.strip()
    scope = f"my-albums:{user.id}" + (":recent" if sort == "recent" else "")
    if q or year is not None:
        # Keep legacy unfiltered cursors valid; filtered scopes stay small even
        # when the search contains 80 Unicode characters.
        filters = json.dumps([sort, q, year], ensure_ascii=False, separators=(",", ":"))
        scope = f"my-albums:{user.id}:filtered:{hashlib.sha256(filters.encode()).hexdigest()}"
    keys = decode_cursor(request, cursor, scope)
    order_key = Album.updated_at if sort == "recent" else func.coalesce(Album.year, 0)
    query = album_query(user.id)
    if q:
        query = query.where(or_(
            City.name.contains(q, autoescape=True),
            City.parent_name.contains(q, autoescape=True),
        ))
    if year is not None:
        query = query.where(Album.year.is_(None) if year == "unmarked" else Album.year == int(year))
    if keys is not None:
        maximum_key = (2**63 - 1) if sort == "recent" else 9999
        if (type(keys[0]) is not int or not 0 <= keys[0] <= maximum_key
                or not isinstance(keys[1], str) or not 1 <= len(keys[1]) <= 36):
            raise ApiError(422, "INVALID_CURSOR", "列表位置已失效，请重新加载")
        query = query.where(or_(
            order_key < keys[0], and_(order_key == keys[0], Album.id > keys[1])
        ))
    with request.app.state.auth.sessions() as db:
        rows = db.execute(query.order_by(order_key.desc(), Album.id).limit(limit + 1)).all()
        items = rows[:limit]
        next_cursor = (
            encode_cursor(request, scope, [
                items[-1][0].updated_at if sort == "recent" else items[-1][0].year or 0,
                items[-1][0].id,
            ])
            if len(rows) > limit
            else None
        )
        return {
            "data": {"items": [album_view(row) for row in items], "next_cursor": next_cursor}
        }


@router.get("/me/albums/options", response_model=Envelope[AlbumOptions])
def my_album_options(request: Request, user: CurrentUser):
    # All owned albums contribute, including empty albums and retired cities.
    # This query is independent of any list page or active search conditions.
    with request.app.state.auth.sessions() as db:
        years = db.scalars(
            select(Album.year).where(Album.owner_id == user.id).distinct()
            .order_by(Album.year.desc())
        ).all()
    return {"data": {"years": years}}


@router.get("/me/city-albums", response_model=Envelope[PageData[CityAlbumView]])
def my_city_albums(
    request: Request, user: CurrentUser, cursor: Cursor = None, limit: Limit = 24,
    sort: Literal["year", "recent"] = "year",
    q: Annotated[str, Query(max_length=80)] = "",
    year: Annotated[str | None, Query(pattern=r"^(?:unmarked|[1-9][0-9]{0,3})$")] = None,
):
    q = q.strip()
    filters = json.dumps([sort, q, year], ensure_ascii=False, separators=(",", ":"))
    scope = f"my-city-albums:{user.id}:{hashlib.sha256(filters.encode()).hexdigest()}"
    keys = decode_cursor(request, cursor, scope)
    # Aggregate all years before paging: a city must never be split across pages.
    albums = (
        select(
            Album.city_id, func.count().label("album_count"),
            func.max(Album.year).label("latest_year"),
            func.max(Album.updated_at).label("updated_at"),
            func.max(case((Album.year.is_(None), 1), else_=0)).label("has_unmarked"),
        )
        .where(Album.owner_id == user.id)
        .group_by(Album.city_id)
    )
    if year is not None:
        # A year selects cities with that year, without truncating city totals.
        matches = Album.year.is_(None) if year == "unmarked" else Album.year == int(year)
        albums = albums.having(func.max(case((matches, 1), else_=0)) == 1)
    albums = albums.subquery()
    photos = (
        select(Album.city_id, func.count(Photo.id).label("photo_count"))
        .join(
            Photo,
            and_(Photo.album_id == Album.id, Photo.owner_id == user.id, Photo.state == "active"),
        )
        .where(Album.owner_id == user.id)
        .group_by(Album.city_id)
        .subquery()
    )
    order_key = albums.c.updated_at if sort == "recent" else func.coalesce(albums.c.latest_year, 0)
    query = (
        select(
            City, albums.c.album_count, func.coalesce(photos.c.photo_count, 0),
            albums.c.latest_year, albums.c.has_unmarked, order_key,
        )
        .join(albums, albums.c.city_id == City.id)
        .outerjoin(photos, photos.c.city_id == City.id)
    )
    if q:
        query = query.where(or_(
            City.name.contains(q, autoescape=True),
            City.parent_name.contains(q, autoescape=True),
        ))
    if keys is not None:
        maximum_key = (2**63 - 1) if sort == "recent" else 9999
        if (type(keys[0]) is not int or not 0 <= keys[0] <= maximum_key
                or not isinstance(keys[1], str) or not 1 <= len(keys[1]) <= 36):
            raise ApiError(422, "INVALID_CURSOR", "列表位置已失效，请重新加载")
        query = query.where(or_(
            order_key < keys[0], and_(order_key == keys[0], City.id > keys[1])
        ))
    with request.app.state.auth.sessions() as db:
        rows = db.execute(query.order_by(order_key.desc(), City.id).limit(limit + 1)).all()
        items = rows[:limit]
        covers = {}
        if items:
            # Rank only photo-bearing albums belonging to this page's cities.
            # Evaluate each winning album's preferred/automatic cover afterwards.
            active_photo = select(Photo.id).where(
                Photo.album_id == Album.id, Photo.owner_id == user.id, Photo.state == "active",
            ).exists()
            ranked = select(
                Album.id.label("album_id"), Album.city_id,
                func.row_number().over(
                    partition_by=Album.city_id,
                    order_by=(func.coalesce(Album.year, 0).desc(), Album.id),
                ).label("position"),
            ).where(
                Album.owner_id == user.id, Album.city_id.in_([row[0].id for row in items]),
                active_photo,
            ).subquery()
            covers = dict(db.execute(
                select(ranked.c.city_id, album_cover(user.id))
                .join(Album, Album.id == ranked.c.album_id)
                .where(ranked.c.position == 1)
            ).all())
        next_cursor = (
            encode_cursor(request, scope, [items[-1][5], items[-1][0].id])
            if len(rows) > limit else None
        )
        return {"data": {
            "items": [{
                "city": city_view(city), "album_count": count, "photo_count": photo_count,
                "latest_year": latest_year, "has_unmarked": bool(has_unmarked),
                "cover_photo_id": covers.get(city.id),
                "original_url": (
                    f"/api/v1/photos/{covers[city.id]}/original" if covers.get(city.id) else None
                ),
            } for city, count, photo_count, latest_year, has_unmarked, _ in items],
            "next_cursor": next_cursor,
        }}


@router.get("/cities/{city_id}/albums", response_model=Envelope[CityAlbums])
def city_albums(
    city_id: str, request: Request, user: CurrentUser, cursor: Cursor = None, limit: Limit = 24
):
    scope = f"albums:{user.id}:{city_id}"
    keys = decode_cursor(request, cursor, scope)
    year = func.coalesce(Album.year, 0)
    query = album_query(user.id).where(Album.city_id == city_id)
    if keys:
        query = query.where(or_(year < keys[0], and_(year == keys[0], Album.id > keys[1])))
    with request.app.state.auth.sessions() as db:
        city = db.get(City, city_id)
        if city is None:
            raise not_found()
        # Retired/unverified cities remain accessible only through one's own history.
        owned = db.scalar(
            select(Album.id).where(Album.owner_id == user.id, Album.city_id == city_id).limit(1)
        )
        if not city_view(city)["can_create"] and owned is None:
            raise not_found()
        rows = db.execute(query.order_by(year.desc(), Album.id).limit(limit + 1)).all()
        items = rows[:limit]
        next_cursor = (
            encode_cursor(request, scope, [items[-1][0].year or 0, items[-1][0].id])
            if len(rows) > limit
            else None
        )
        return {
            "data": {
                "city": city_view(city),
                "items": [album_view(row) for row in items],
                "next_cursor": next_cursor,
            }
        }


@router.post(
    "/cities/{city_id}/albums",
    status_code=201,
    response_model=Envelope[CreatedAlbum],
    responses={200: {"model": Envelope[CreatedAlbum], "description": "Existing album"}},
)
def create_album(
    city_id: str, data: CreateAlbum, request: Request, response: Response, user: CurrentUser
):
    now = request.app.state.auth.clock()
    # INSERT is the first statement in this transaction. No read->write snapshot
    # upgrade race; the two DB unique indexes arbitrate concurrent duplicate years.
    statement = (
        insert(Album)
        .from_select(
            ["id", "owner_id", "city_id", "year", "revision", "created_at", "updated_at"],
            select(
                literal(str(uuid4())),
                literal(user.id),
                City.id,
                literal(data.year),
                literal(1),
                literal(now),
                literal(now),
            ).where(City.id == city_id, City.is_active == 1, City.mapping_status == "verified"),
        )
        .on_conflict_do_nothing()
        .returning(Album.id)
    )
    with request.app.state.auth.sessions.begin() as db:
        created = db.scalar(statement) is not None
        city = db.get(City, city_id)
        if city is None:
            raise not_found()
        if not city_view(city)["can_create"]:
            raise ApiError(409, "CITY_UNAVAILABLE", "这个城市暂不能新建影集，已有影集仍可查看")
        row = db.execute(
            album_query(user.id).where(Album.city_id == city_id, Album.year == data.year)
        ).one()
        result = album_view(row)
    response.status_code = 201 if created else 200
    return {"data": {**result, "created": created}}


@router.get("/albums/{album_id}", response_model=Envelope[AlbumView])
def album_detail(album_id: str, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions() as db:
        row = db.execute(album_query(user.id).where(Album.id == album_id)).one_or_none()
        if row is None:
            raise not_found()
        return {"data": album_view(row)}


@router.patch("/albums/{album_id}/cover", response_model=Envelope[AlbumView])
def set_cover(album_id: str, data: CoverInput, request: Request, user: CurrentUser):
    with request.app.state.auth.sessions.begin() as db:
        # Serialize membership/version reads with imports, moves and deletion.
        db.execute(
            update(Album)
            .where(Album.id == album_id, Album.owner_id == user.id)
            .values(revision=Album.revision)
        )
        album = db.scalar(select(Album).where(Album.id == album_id, Album.owner_id == user.id))
        if album is None:
            raise not_found()
        if data.photo_id is not None:
            photo = db.scalar(select(Photo.id).where(
                Photo.id == data.photo_id, Photo.album_id == album_id,
                Photo.owner_id == user.id, Photo.state == "active",
            ))
            if photo is None:
                raise not_found()
        if album.revision != data.expected_revision:
            raise ApiError(409, "ALBUM_CHANGED", "影集已有更新，请重新核对照片列表")
        if album.preferred_cover_photo_id != data.photo_id:
            album.preferred_cover_photo_id = data.photo_id
            album.revision += 1
            album.updated_at = request.app.state.auth.clock()
            db.flush()
        row = db.execute(album_query(user.id).where(Album.id == album_id)).one()
        return {"data": album_view(row)}
