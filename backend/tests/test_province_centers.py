from sqlalchemy import func, select, update
from starlette.requests import Request
from test_albums import GUANGZHOU, SHENZHEN, create, signed_in
from test_auth import environment as environment

from city_memories.albums import encode_cursor
from city_memories.models import City

PATH = "/api/v1/cities"
VIEW = "province-centers"
# Acceptance order is written in visible city names, independently of the
# implementation's business IDs and SQL ordering keys.
EXPECTED_NAMES = [
    "澳门特别行政区", "北京市", "长春市", "长沙市", "成都市", "重庆市", "福州市", "广州市",
    "贵阳市", "哈尔滨市", "海口市", "杭州市", "合肥市", "呼和浩特市", "济南市", "昆明市",
    "兰州市", "拉萨市", "南昌市", "南京市", "南宁市", "上海市", "沈阳市", "石家庄市",
    "台北市", "太原市", "天津市", "武汉市", "乌鲁木齐市", "西安市", "香港特别行政区",
    "西宁市", "银川市", "郑州市",
]


def test_one_reviewed_entry_per_region_in_pinyin_order(environment):
    app, client, _, _ = environment
    anonymous = client.get(PATH, params={"view": VIEW, "limit": 100})
    assert anonymous.status_code == 401
    assert anonymous.headers["cache-control"] == "private, no-store"
    signed_in(client)
    response = client.get(PATH, params={"view": VIEW, "limit": 100})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    data = response.json()["data"]
    items = data["items"]
    assert data["next_cursor"] is None
    assert [city["name"] for city in items] == EXPECTED_NAMES
    assert len({city["id"] for city in items}) == 34
    assert all(city["can_create"] for city in items)
    assert all(set(city) == {"id", "name", "parent_name", "unit_kind", "can_create"}
               for city in items)
    by_region = {city["parent_name"] or city["name"]: city for city in items}
    assert len(by_region) == 34
    assert by_region["广东省"]["id"] == GUANGZHOU
    assert by_region["台湾省"]["name"] == "台北市"
    assert by_region["内蒙古自治区"]["name"] == "呼和浩特市"
    assert by_region["广西壮族自治区"]["name"] == "南宁市"
    assert by_region["宁夏回族自治区"]["name"] == "银川市"
    assert by_region["新疆维吾尔自治区"]["name"] == "乌鲁木齐市"
    assert by_region["西藏自治区"]["name"] == "拉萨市"
    with app.state.auth.sessions() as db:
        regions = {
            city.parent_name or city.name
            for city in db.scalars(select(City).where(City.is_active == 1))
        }
    assert set(by_region) == regions


def test_center_pagination_is_complete_without_duplicates(environment):
    _, client, _, _ = environment
    signed_in(client)
    default = client.get(PATH, params={"view": VIEW}).json()["data"]
    assert [city["name"] for city in default["items"]] == EXPECTED_NAMES[:24]
    assert default["next_cursor"]
    collected = []
    cursor = None
    while True:
        params = {"view": VIEW, "limit": 7}
        if cursor:
            params["cursor"] = cursor
        response = client.get(PATH, params=params)
        assert response.status_code == 200
        page = response.json()["data"]
        collected.extend(page["items"])
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert [city["name"] for city in collected] == EXPECTED_NAMES
    assert len({city["id"] for city in collected}) == 34


def test_full_search_keeps_non_capitals_and_view_filter_is_optional(environment):
    _, client, _, _ = environment
    signed_in(client)
    entries = client.get(PATH, params={"view": VIEW, "q": " 广东 "}).json()["data"]
    assert [city["id"] for city in entries["items"]] == [GUANGZHOU]
    assert entries["next_cursor"] is None
    for view in ({}, {"view": "all"}):
        guangdong = client.get(PATH, params={**view, "q": "广东"}).json()["data"]["items"]
        assert len(guangdong) == 21
        assert {GUANGZHOU, SHENZHEN} <= {city["id"] for city in guangdong}
        shenzhen = client.get(PATH, params={**view, "q": "深圳"}).json()["data"]["items"]
        assert [city["id"] for city in shenzhen] == [SHENZHEN]
    assert client.get(PATH, params={"view": VIEW, "q": "深圳"}).json()["data"]["items"] == []
    for query in ("不存在", "%", "_", "' OR 1=1 --"):
        assert client.get(PATH, params={"view": VIEW, "q": query}).json()["data"] == {
            "items": [], "next_cursor": None,
        }
    assert len(client.get("/api/v1/map/cities").json()["data"]) == 391
    assert create(client, 2026, SHENZHEN).status_code == 201


def test_selection_respects_status_without_replacing_or_changing_history(environment):
    app, client, _, _ = environment
    signed_in(client)
    album = create(client, 2026, GUANGZHOU).json()["data"]
    with app.state.auth.sessions.begin() as db:
        original_count = db.scalar(select(func.count()).select_from(City))
        db.execute(update(City).where(City.id == GUANGZHOU).values(is_active=0))
        db.execute(update(City).where(City.name == "北京市").values(mapping_status="pending"))
    data = client.get(PATH, params={"view": VIEW, "limit": 100}).json()["data"]
    assert [city["name"] for city in data["items"]] == [
        name for name in EXPECTED_NAMES if name not in ("广州市", "北京市")
    ]
    assert not any(city["parent_name"] == "广东省" for city in data["items"])
    history = client.get(f"/api/v1/albums/{album['id']}").json()["data"]
    assert history["city"]["id"] == GUANGZHOU and history["city"]["can_create"] is False
    assert create(client, 2027, GUANGZHOU).status_code == 409
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(City)) == original_count
        assert db.get(City, GUANGZHOU).is_active == 0


def test_center_cursor_is_scoped_and_validated(environment):
    app, client, _, _ = environment
    signed_in(client)
    first = client.get(PATH, params={"view": VIEW, "limit": 1}).json()["data"]
    cursor = first["next_cursor"]
    for params in (
        {"cursor": cursor},
        {"view": "all", "cursor": cursor},
        {"view": VIEW, "q": "广东", "cursor": cursor},
        {"view": VIEW, "cursor": cursor + "x"},
        {"view": "invalid"},
    ):
        assert client.get(PATH, params=params).status_code == 422
    all_cursor = client.get(PATH, params={"limit": 1}).json()["data"]["next_cursor"]
    assert client.get(PATH, params={"view": VIEW, "cursor": all_cursor}).status_code == 422
    next_page = client.get(PATH, params={"view": VIEW, "q": "  ", "cursor": cursor})
    assert next_page.status_code == 200
    assert next_page.json()["data"]["items"][0]["name"] == "北京市"
    request = Request({"type": "http", "app": app})
    for keys in ([0, first["items"][0]["id"]], ["aomen", []], ["wrong", GUANGZHOU]):
        malformed = encode_cursor(request, "province-centers:v1:", keys)
        assert client.get(PATH, params={"view": VIEW, "cursor": malformed}).status_code == 422
    # A full-list query can contain arbitrary text, including the new view name;
    # its cursor namespace must still never match the center-list namespace.
    other_scope = encode_cursor(request, "cities:province-centers:v1:",
                                ["aomen", first["items"][0]["id"]])
    assert client.get(PATH, params={"view": VIEW, "cursor": other_scope}).status_code == 422
