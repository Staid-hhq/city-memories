"""Rebuild the public city-map asset using only pinned, public boundary data.

No application settings, private data, API keys or third-party Python packages
are used. Source downloads stay in validation/map-plan/results/map-sources (ignored).
"""

import argparse
import hashlib
import json
import math
import sqlite3
import struct
import urllib.request
from itertools import pairwise
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "frontend/public/map-data"
SOURCES = {
    "china-city.raw.geojson": (
        (
            "https://raw.githubusercontent.com/zzhonglei/GeoCode-Release/"
            "6e3534f7af3675b19bd3c5d54c94022959dccdd2/"
            "contributions/china-admin-boundaries/skill/data/china_city.geojson"
        ),
        "a3038b09823597c5b03ea2563455cebcc90559e83764f5d49d38a1403ad8683a",
    ),
    "taiwan-counties.raw.topojson": (
        "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/counties-10t.json",
        "cd4be67df3c7497d3dd49106b17e6f337aeb2466140e4499287799892c15ac7b",
    ),
    "china-thematic-base.raw.gpkg": (
        (
            "https://raw.githubusercontent.com/zzhonglei/GeoCode-Release/"
            "6e3534f7af3675b19bd3c5d54c94022959dccdd2/"
            "contributions/thematic-map/skill/data/china_thematic_base_wgs84.gpkg"
        ),
        "ddcc802cd74f3477bc1e64966912eedf4c5acc74d737e499f6bf8f71612c7778",
    ),
}


def read_source(directory, name, download):
    url, expected = SOURCES[name]
    path = directory / name
    if not path.exists():
        if not download:
            raise ValueError(f"Missing public source {name}; use --download")
        directory.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read(8_000_001)
        if len(content) > 8_000_000:
            raise ValueError("Public map source exceeds download limit")
        path.write_bytes(content)
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != expected:
        raise ValueError(f"Public source checksum mismatch: {name}")
    return path if name.endswith(".gpkg") else json.loads(content)


def national_lines(source):
    """Decode only the three fixed public line layers; never close them as faces."""

    def decode(blob):
        if blob[:3] != b"GP\x00" or blob[3] & 0b00110000:
            raise ValueError("Unsupported public GeoPackage geometry")
        flags = blob[3]
        endian = "<" if flags & 1 else ">"
        if struct.unpack_from(endian + "i", blob, 4)[0] != 4326:
            raise ValueError("Expected WGS84 geographic line coordinates")
        start = 8 + {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}[(flags >> 1) & 7] * 8

        def wkb(position):
            endian = "<" if blob[position] == 1 else ">"
            kind, count = (
                struct.unpack_from(endian + "I", blob, position + 1)[0],
                struct.unpack_from(endian + "I", blob, position + 5)[0],
            )
            position += 9
            if kind == 2:
                points = []
                for _ in range(count):
                    x, y = struct.unpack_from(endian + "dd", blob, position)
                    if not math.isfinite(x + y) or not (
                        70 <= x <= 140 and 0 <= y <= 60
                    ):
                        raise ValueError("Line coordinates outside China map extent")
                    points.append([round(x, 5), round(y, 5)])
                    position += 16
                return [points], position
            if kind != 5:
                raise ValueError("Expected two-dimensional line geometry")
            lines = []
            for _ in range(count):
                child, position = wkb(position)
                lines.extend(child)
            return lines, position

        lines, end = wkb(start)
        if end != len(blob):
            raise ValueError("Trailing public line bytes")
        return lines

    result = []
    with sqlite3.connect(
        source.resolve().as_uri() + "?mode=ro&immutable=1", uri=True
    ) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        for table in ("border", "coast", "ninedash"):
            metadata = db.execute(
                "SELECT srs_id, geometry_type_name FROM gpkg_geometry_columns WHERE table_name=?",
                (table,),
            ).fetchone()
            if metadata != (4326, "MULTILINESTRING"):
                raise ValueError("Unexpected public line metadata")
            for row in db.execute(f'SELECT geom FROM "{table}" ORDER BY fid'):
                result.extend(decode(row[0]))
    return result


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in pairwise(ring)) / 2


def geometry(raw):
    if raw["type"] == "Polygon":
        polygons = [raw["coordinates"]]
    elif raw["type"] == "MultiPolygon":
        polygons = raw["coordinates"]
    else:
        raise ValueError("Expected polygon geometry")
    result = []
    for polygon in polygons:
        rings = []
        for index, ring in enumerate(polygon):
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError("Unclosed source ring")
            if any(not math.isfinite(v) for p in ring for v in p):
                raise ValueError("Non-finite source coordinates")
            # Quantization only: do not simplify, drop islands, dissolve city
            # divisions or remove holes. Retain precision for tiny components.
            rounded = [[round(p[0], 5), round(p[1], 5)] for p in ring]
            if len({tuple(p) for p in rounded}) < 3 or signed_area(rounded) == 0:
                rounded = [[p[0], p[1]] for p in ring]
            if (signed_area(rounded) > 0) != (index == 0):
                rounded.reverse()
            rings.append(rounded)
        result.append(rings)
    return result


def inside(point, ring):
    x, y = point
    contained = False
    for a, b in pairwise(ring):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (
            b[1] - a[1]
        ) + a[0]:
            contained = not contained
    return contained


def representative(polygons):
    polygon = max(polygons, key=lambda p: abs(signed_area(p[0])))
    ring = polygon[0]
    bottom, top = min(p[1] for p in ring), max(p[1] for p in ring)
    choices = []
    for ratio in (0.5, 0.4, 0.6, 0.25, 0.75):
        y = bottom + (top - bottom) * ratio
        edges = sorted(
            a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            for a, b in pairwise(ring)
            if (a[1] > y) != (b[1] > y)
        )
        for left, right in zip(edges[::2], edges[1::2], strict=True):
            point = [(left + right) / 2, y]
            if inside(point, ring) and not any(
                inside(point, hole) for hole in polygon[1:]
            ):
                choices.append((right - left, point))
    if not choices:
        raise ValueError("Cannot place a city locator inside its largest polygon")
    return [round(v, 5) for v in max(choices)[1]]


def taiwan_features(topology):
    transform = topology["transform"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append(
                [
                    x * transform["scale"][0] + transform["translate"][0],
                    y * transform["scale"][1] + transform["translate"][1],
                ]
            )
        arcs.append(points)

    def ring(indices):
        points = []
        for index in indices:
            part = arcs[index] if index >= 0 else list(reversed(arcs[~index]))
            if points and points[-1] != part[0]:
                raise ValueError("Shared TopoJSON arcs do not meet")
            points.extend(part[1:] if points else part)
        return points

    for item in topology["objects"]["counties"]["geometries"]:
        indices = [item["arcs"]] if item["type"] == "Polygon" else item["arcs"]
        yield (
            item["properties"]["COUNTYNAME"],
            {
                "type": "MultiPolygon",
                "coordinates": [
                    [ring(indices_) for indices_ in polygon] for polygon in indices
                ],
            },
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=ROOT / "validation/map-plan/results/map-sources",
    )
    parser.add_argument("--download", action="store_true")
    arguments = parser.parse_args()
    mainland = read_source(
        arguments.source_dir, "china-city.raw.geojson", arguments.download
    )
    taiwan = read_source(
        arguments.source_dir, "taiwan-counties.raw.topojson", arguments.download
    )
    borders = national_lines(
        read_source(
            arguments.source_dir, "china-thematic-base.raw.gpkg", arguments.download
        )
    )
    catalog = json.loads(
        (ROOT / "backend/src/city_memories/city-catalog.json").read_text(
            encoding="utf-8"
        )
    )
    cities = [c for c in catalog["cities"] if c["mapping_status"] == "verified"]
    by_code = {c["provider_code"]: c for c in cities}
    taiwan_by_name = {
        c["name"]: c for c in cities if c["unit_kind"] == "taiwan-destination"
    }
    replacements = str.maketrans("臺縣義蓮雲東園蘭連門", "台县义莲云东园兰连门")
    regions, background, seen = [], [], set()

    def add(city, shape):
        code = city["provider_code"]
        if code in seen:
            raise ValueError("Duplicate business city boundary")
        seen.add(code)
        regions.append(
            {
                key: city[key]
                for key in ("provider_code", "name", "parent_name", "unit_kind")
            }
            | {"center": representative(shape), "geometry": shape}
        )

    for feature in mainland["features"]:
        properties = feature["properties"]
        code = properties["gb"]
        if code == "156710000":
            continue  # Use individually matched Taiwan counties below.
        shape = geometry(feature["geometry"])
        if code in by_code:
            if properties["name"] != by_code[code]["name"]:
                raise ValueError("Mainland city name/code mismatch")
            add(by_code[code], shape)
        else:
            background.extend(shape)  # No new album destinations are created.
    for name, feature in taiwan_features(taiwan):
        shape = geometry(feature)
        simplified = name.translate(replacements)
        if simplified in taiwan_by_name:
            add(taiwan_by_name[simplified], shape)
        elif simplified in ("金门县", "连江县"):
            background.extend(shape)
        else:
            raise ValueError("Unreviewed Taiwan county name")
    if seen != set(by_code):
        raise ValueError(
            f"Coverage differs from reviewed catalog: {len(set(by_code) - seen)} missing"
        )
    regions.sort(key=lambda r: r["provider_code"])
    asset = {
        "schema_version": 1,
        "revision": "2026-10-22",
        "regions": regions,
        "background": background,
        "borders": borders,
    }
    encoded = (
        json.dumps(asset, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    DATA.mkdir(parents=True, exist_ok=True)
    destination = DATA / "china-cities.v1.json"
    destination.write_bytes(encoded)
    print(
        f"Public China city asset: {len(regions)} verified destinations, {len(encoded)} bytes"
    )
    print(f"SHA256: {hashlib.sha256(encoded).hexdigest()}")


if __name__ == "__main__":
    main()
