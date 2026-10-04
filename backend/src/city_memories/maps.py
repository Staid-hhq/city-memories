"""Reviewed public city identities and authenticated browser-only map configuration."""

import json
import re
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Request
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from city_memories.albums import CityView, Envelope, city_view
from city_memories.auth import CurrentUser
from city_memories.errors import ApiError
from city_memories.models import City

router = APIRouter(prefix="/api/v1/map", tags=["map"])
CATALOG = json.loads(Path(__file__).with_name("city-catalog.json").read_text(encoding="utf-8"))


def seed_reviewed_cities(engine) -> None:
    """Add missing identities only; never overwrite retired/review-pending user mappings."""
    rows = CATALOG["cities"]
    if len({r["id"] for r in rows}) != len(rows) or len(
        {r["provider_code"] for r in rows}
    ) != len(rows):
        raise RuntimeError("Business city catalog has duplicate identities")
    for row in rows:
        UUID(row["id"])
        if not re.fullmatch(r"156\d{6}", row["provider_code"]):
            raise RuntimeError("Business city catalog has invalid codes")
    with engine.begin() as connection:
        connection.execute(insert(City).on_conflict_do_nothing(), [
            {**{k: v for k, v in row.items() if k != "source"},
             "provider": "tianditu", "is_active": 1}
            for row in rows
        ])


class MapCity(CityView):
    provider_code: str


@router.get("/cities", response_model=Envelope[list[MapCity]])
def map_cities(request: Request, user: CurrentUser):
    # No client registration endpoint: external responses cannot authorize an album.
    with request.app.state.auth.sessions() as db:
        cities = db.scalars(select(City).where(
            City.provider == "tianditu", City.is_active == 1,
            City.mapping_status == "verified",
        ).order_by(City.provider_code)).all()
        return {"data": [{**city_view(city), "provider_code": city.provider_code}
                         for city in cities]}


@router.get("/config")
def map_config(request: Request, user: CurrentUser):
    settings = request.app.state.auth.settings
    origin = request.headers.get("origin")
    if (origin and origin not in settings.allowed_origins) or request.headers.get(
        "sec-fetch-site"
    ) == "cross-site":
        raise ApiError(403, "MAP_ORIGIN_DENIED", "请从本系统页面打开地图")
    key = settings.map_key.get_secret_value() if settings.map_key else ""
    if not key and settings.map_key_file:
        try:
            # Local owner-configured file only; no request parameter can choose a path.
            with settings.map_key_file.open(encoding="utf-8-sig") as stream:
                text = stream.read(8193)
            match = re.search(r"^\s*TIANDITU_KEY\s*=\s*[\"']?([a-f\d]{32})[\"']?\s*(?:#.*)?$",
                              text, re.I | re.M) if len(text) <= 8192 else None
            key = match[1] if match else ""
        except (OSError, UnicodeError):
            pass
    enabled = bool(re.fullmatch(r"[a-f\d]{32}", key, re.I) and settings.map_review_number
                   and settings.map_review_date)
    return {"data": {
        "enabled": enabled, "key": key if enabled else None,
        "review_number": settings.map_review_number if enabled else None,
        "review_date": settings.map_review_date if enabled else None,
        "catalog_version": CATALOG["version"],
        "message": None if enabled else "地图配置暂不可用，仍可搜索城市和打开自己的影集。",
    }}
