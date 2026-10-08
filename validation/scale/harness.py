"""T15 HTTP load, measurements and read-only audit of this harness's temporary DB."""

import argparse
import hashlib
import json
import math
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import median
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parent / "results"
FIXTURES = ROOT / "fixtures-3400"
ORIGIN = "http://127.0.0.1:8000"
CITY = "a03b8f10-06dd-4b56-aef1-33cfc3696301"
PASSWORD = "Only for isolated T15 synthetic tests!"


def stats(values):
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "min_ms": round(ordered[0], 3),
        "median_ms": round(median(ordered), 3),
        "p95_ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1], 3),
        "max_ms": round(ordered[-1], 3),
    }


class Client:
    def __init__(self, username, register=False):
        state = isolated_state()
        self.client = httpx.Client(
            base_url=ORIGIN, timeout=120, trust_env=False, headers={"Origin": ORIGIN}
        )
        # Refuse writes to an unrelated localhost service, even when run directly.
        try:
            identity = self.client.get("/t15-isolated-identity")
            assert identity.status_code == 200 and identity.json() == {
                "identity": state["identity"]
            }
        except Exception:
            self.client.close()
            raise
        token = self.call("GET", "/auth/csrf")["csrf_token"]
        self.client.headers["X-CSRF-Token"] = token
        credentials = {"username": username, "password": PASSWORD}
        if register:
            self.call("POST", "/auth/register", json=credentials | {"password_confirm": PASSWORD})
        result = self.call("POST", "/auth/login", json=credentials)
        self.client.headers["X-CSRF-Token"] = result["csrf_token"]

    def call(self, method, path, **kwargs):
        response = self.client.request(method, "/api/v1" + path, **kwargs)
        # Log only status and error code, never credentials, cookies, or full responses.
        if not response.is_success:
            raise AssertionError(
                f"HTTP {response.status_code}: "
                f"{response.json().get('error', {}).get('code', 'UNKNOWN')}"
            )
        return response.json()["data"] if response.status_code != 204 else None

    def photos(self, album):
        items, cursor = [], None
        while True:
            value = self.call(
                "GET",
                f"/albums/{album}/photos",
                params={"limit": 100} | ({"cursor": cursor} if cursor else {}),
            )
            items.extend(value["items"])
            cursor = value["next_cursor"]
            if not cursor:
                assert len(items) == value["photo_count"]
                return items

    def close(self):
        self.client.close()


def manifest():
    result = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    assert result["synthetic"] and len(result["items"]) == 3400
    return result


def isolated_state():
    state = json.loads((ROOT / "server.json").read_text(encoding="utf-8"))
    directory = Path(state["data_dir"]).resolve()
    assert directory.parent == ROOT.resolve() and directory.name.startswith("t15-runtime-")
    assert (directory / "t15-isolated.txt").read_text(encoding="utf-8") == "synthetic-only"
    return state


def populate():
    corpus = manifest()["items"]
    start = time.perf_counter()
    barrier = threading.Barrier(2)

    def account(username, indices, first_year):
        client = Client(username, register=username == "Scale_Two")
        report = {
            "username": username,
            "albums": [],
            "upload_ms": [],
            "commit_ms": [],
            "read_during_upload_ms": [],
            "uploaded_bytes": 0,
        }
        barrier.wait(timeout=30)
        try:
            for batch_number, offset in enumerate(range(0, len(indices), 400)):
                entries = [corpus[index] for index in indices[offset : offset + 400]]
                album = client.call(
                    "POST", f"/cities/{CITY}/albums", json={"year": first_year + batch_number}
                )
                data = [
                    {
                        "original_filename": item["name"],
                        "byte_size": item["byte_size"],
                        "sha256": item["sha256"],
                    }
                    for item in entries
                ]
                batch = client.call(
                    "POST",
                    f"/albums/{album['id']}/imports",
                    json={"items": data},
                    headers={"Idempotency-Key": str(uuid4())},
                )
                # One upload per account: two actual concurrent global transfers,
                # respecting rather than disabling the production semaphore.
                for entry, item in zip(entries, batch["items"], strict=True):
                    tick = time.perf_counter()
                    with (FIXTURES / entry["name"]).open("rb") as stream:
                        received = client.call(
                            "PUT",
                            f"/imports/{batch['id']}/items/{item['id']}/content",
                            files={"file": (entry["name"], stream)},
                        )
                    assert received["state"] == "staged"
                    report["upload_ms"].append((time.perf_counter() - tick) * 1000)
                    report["uploaded_bytes"] += entry["byte_size"]
                    if len(report["upload_ms"]) % 50 == 0:
                        tick = time.perf_counter()
                        client.call("GET", "/me/atlas")
                        report["read_during_upload_ms"].append((time.perf_counter() - tick) * 1000)
                        print(
                            f"{username}: uploaded {len(report['upload_ms'])}/{len(indices)}",
                            flush=True,
                        )
                tick = time.perf_counter()
                receipt = client.call(
                    "POST",
                    f"/imports/{batch['id']}/commit",
                    json={"expected_album_revision": batch["album_revision"]},
                )
                report["commit_ms"].append((time.perf_counter() - tick) * 1000)
                assert not receipt["failed_item_ids"] and len(receipt["photo_ids"]) == len(entries)
                photos = client.photos(album["id"])
                assert [p["original_filename"] for p in photos] == [e["name"] for e in entries]
                assert [p["position"] for p in photos] == list(range(len(entries)))
                report["albums"].append(
                    {"id": album["id"], "count": len(entries), "year": album["year"]}
                )
            for name in ("upload_ms", "commit_ms", "read_during_upload_ms"):
                report[name] = stats(report[name])
            return report
        finally:
            client.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(account, "Scale_One", list(range(400, 3000)), 2000)
        second = pool.submit(account, "Scale_Two", list(range(3000, 3400)), 2026)
        accounts = [first.result(), second.result()]
    result = {"seconds": round(time.perf_counter() - start, 3), "accounts": accounts}
    (ROOT / "population.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("T15 HTTP population complete: owner 3000 + second account 400", flush=True)


def benchmark():
    corpus = manifest()["items"]
    clients = [Client("Scale_One"), Client("Scale_Two")]
    samples = {name: [] for name in ("first_page", "atlas", "note", "reorder", "original")}
    raw_samples = {name: [] for name in samples}
    try:
        albums = []
        for client, count in zip(clients, [3000, 400], strict=True):
            atlas = client.call("GET", "/me/atlas")
            assert atlas["photo_count"] == count
            available = client.call("GET", f"/cities/{CITY}/albums", params={"limit": 100})["items"]
            albums.append(next(a for a in available if a["year"] == 2026)["id"])
        originals = [client.photos(album) for client, album in zip(clients, albums, strict=True)]
        barrier = threading.Barrier(2)

        def worker(index):
            client, album = clients[index], albums[index]
            first, second = originals[index][:2]
            local = {name: [] for name in samples}
            barrier.wait(timeout=10)
            for iteration in range(30):

                def timed(name, method, path, **kwargs):
                    start = time.perf_counter()
                    result = client.call(method, path, **kwargs)
                    local[name].append((time.perf_counter() - start) * 1000)
                    return result

                listing = timed("first_page", "GET", f"/albums/{album}/photos")
                assert len(listing["items"]) == 24 and listing["photo_count"] == 400
                timed("atlas", "GET", "/me/atlas")
                detail = client.call("GET", f"/photos/{first['id']}")
                saved = timed(
                    "note",
                    "PATCH",
                    f"/photos/{first['id']}/note",
                    json={
                        "note": f"T15 account {index} iteration {iteration} 独立文字",
                        "expected_photo_revision": detail["revision"],
                    },
                )
                assert saved["note"].endswith("独立文字")
                # Alternate first -> last -> first so the final full order is unchanged.
                timed(
                    "reorder",
                    "POST",
                    f"/albums/{album}/reorder",
                    json={
                        "photo_id": first["id"],
                        "before_photo_id": None if iteration % 2 == 0 else second["id"],
                        "expected_album_revision": listing["album_revision"],
                    },
                )
                if iteration % 3 == 0:
                    start = time.perf_counter()
                    response = client.client.get(
                        f"/api/v1/photos/{originals[index][iteration]['id']}/original"
                    )
                    assert response.status_code == 200
                    item = corpus[index * 3000 + iteration]
                    assert hashlib.sha256(response.content).hexdigest() == item["sha256"]
                    local["original"].append((time.perf_counter() - start) * 1000)
                denied = client.client.get(
                    f"/api/v1/photos/{originals[1 - index][0]['id']}/original"
                )
                assert denied.status_code == 404
            assert [p["id"] for p in client.photos(album)] == [p["id"] for p in originals[index]]
            return local

        start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(worker, range(2)))
        for result in results:
            for name, values in result.items():
                samples[name].extend(values)
        for name, values in samples.items():
            raw_samples[name] = values
        # Real same-version conflict at full 400-photo scale; no artificial 409.
        client, album = clients[0], albums[0]
        current = client.call("GET", f"/albums/{album}/photos")
        token = client.client.headers["X-CSRF-Token"]
        cookies = client.client.cookies
        gate = threading.Barrier(2)

        def conflict(which):
            with httpx.Client(
                base_url=ORIGIN,
                cookies=cookies,
                trust_env=False,
                headers={"Origin": ORIGIN, "X-CSRF-Token": token},
            ) as contender:
                gate.wait(timeout=10)
                return contender.post(
                    f"/api/v1/albums/{album}/reorder",
                    json={
                        "photo_id": originals[0][which]["id"],
                        "before_photo_id": None,
                        "expected_album_revision": current["album_revision"],
                    },
                ).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(conflict, [0, 1]))
        assert statuses == [200, 409]
        now = client.photos(album)
        moved = now[-1]
        anchor = originals[0][1 if moved["id"] == originals[0][0]["id"] else 2]["id"]
        revision = client.call("GET", f"/albums/{album}")["revision"]
        client.call(
            "POST",
            f"/albums/{album}/reorder",
            json={
                "photo_id": moved["id"],
                "before_photo_id": anchor,
                "expected_album_revision": revision,
            },
        )
        assert [p["id"] for p in client.photos(album)] == [p["id"] for p in originals[0]]
        summary = {
            "seconds": time.perf_counter() - start,
            "concurrent_accounts": 2,
            "iterations_per_account": 30,
            "same_version_statuses": statuses,
            "samples": {name: stats(values) for name, values in samples.items()},
            "raw_ms": raw_samples,
        }
        (ROOT / "benchmark.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        for name in ("first_page", "note", "reorder"):
            assert summary["samples"][name]["p95_ms"] <= 1000, (
                f"T15 latency budget exceeded: {name}"
            )
        print(json.dumps({"benchmark": summary["samples"], "conflict": statuses}), flush=True)
    finally:
        for client in clients:
            client.close()


def audit():
    state = isolated_state()
    directory = Path(state["data_dir"]).resolve()
    corpus = {item["name"]: item for item in manifest()["items"]}
    database = directory / "database/city-memories.sqlite3"
    with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        rows = db.execute(
            "SELECT p.*, u.username FROM photos p JOIN users u ON u.id=p.owner_id "
            "ORDER BY album_id,position"
        ).fetchall()
    assert len(rows) == 3400 and len({row["sha256"] for row in rows}) == 3400
    seen = set()
    albums = {}
    owners = {}
    for row in rows:
        item = corpus[row["original_filename"]]
        assert row["original_filename"] not in seen
        seen.add(row["original_filename"])
        assert row["state"] == "active" and row["sha256"] == item["sha256"]
        assert row["byte_size"] == item["byte_size"]
        assert (row["width"], row["height"]) == (item["width"], item["height"])
        expected_owner = "Scale_One" if item["index"] < 3000 else "Scale_Two"
        assert row["username"] == expected_owner
        if item["index"] in (0, 3000):
            assert row["note"] == f"T15 account {item['index'] // 3000} iteration 29 独立文字"
        path = directory / "originals" / row["storage_key"]
        assert (
            path.resolve().parent == (directory / "originals").resolve() and not path.is_symlink()
        )
        with path.open("rb") as stream:
            assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]
        with (FIXTURES / item["name"]).open("rb") as stream:
            assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]
        albums.setdefault(row["album_id"], []).append((row["position"], item["index"]))
        owners[expected_owner] = owners.get(expected_owner, 0) + 1
    for values in albums.values():
        assert [position for position, _ in values] == list(range(len(values)))
        assert [index for _, index in values] == sorted(index for _, index in values)
    assert owners == {"Scale_One": 3000, "Scale_Two": 400}
    result = {
        "photos": len(rows),
        "unique_hashes": len(seen),
        "owners": owners,
        "album_counts": sorted(len(values) for values in albums.values()),
        "all_source_and_saved_hashes_match": True,
        "sqlite_integrity": "ok",
    }
    (ROOT / "audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)


def lifecycle():
    """Exercise the 3000-member trash cursor through public APIs, then restore."""
    client = Client("Scale_One")
    other = Client("Scale_Two")
    start = time.perf_counter()
    measured = {name: [] for name in ("trash", "restore", "trash_first_page")}
    try:
        albums = client.call("GET", f"/cities/{CITY}/albums", params={"limit": 100})["items"]
        originals = {album["id"]: client.photos(album["id"]) for album in albums}
        assert sum(map(len, originals.values())) == 3000
        revisions = {album["id"]: album["revision"] for album in albums}
        deleted = {}
        for album_id, photos in originals.items():
            for photo in photos:
                tick = time.perf_counter()
                value = client.call(
                    "POST",
                    f"/photos/{photo['id']}/trash",
                    json={
                        "expected_photo_revision": photo["revision"],
                        "expected_album_revision": revisions[album_id],
                    },
                )
                measured["trash"].append((time.perf_counter() - tick) * 1000)
                revisions[album_id] = value["album_revision"]
                deleted[photo["id"]] = value
            print(f"T15 trash populated: {len(deleted)}/3000", flush=True)
        for _ in range(30):
            tick = time.perf_counter()
            listing = client.call("GET", "/trash/photos")
            measured["trash_first_page"].append((time.perf_counter() - tick) * 1000)
            assert listing["photo_count"] == 3000 and len(listing["items"]) == 24
        seen, cursor = [], None
        while True:
            listing = client.call(
                "GET",
                "/trash/photos",
                params={"limit": 100} | ({"cursor": cursor} if cursor else {}),
            )
            seen.extend(photo["id"] for photo in listing["items"])
            cursor = listing["next_cursor"]
            if not cursor:
                break
        expected_order = sorted(deleted, key=lambda key: (-deleted[key]["deleted_at"], key))
        assert seen == expected_order and len(set(seen)) == 3000
        assert client.call("GET", "/me/atlas")["photo_count"] == 0
        assert other.call("GET", "/me/atlas")["photo_count"] == 400
        assert other.call("GET", "/trash/photos")["photo_count"] == 0
        assert other.client.get(f"/api/v1/trash/photos/{seen[0]}/original").status_code == 404
        for album_id, photos in originals.items():
            # Restore whole albums in original order, not the reverse trash order.
            for photo in photos:
                tick = time.perf_counter()
                value = client.call(
                    "POST",
                    f"/trash/photos/{photo['id']}/restore",
                    json={
                        "expected_photo_revision": deleted[photo["id"]]["revision"],
                        "expected_album_revision": revisions[album_id],
                    },
                )
                measured["restore"].append((time.perf_counter() - tick) * 1000)
                revisions[album_id] = value["album_revision"]
                assert value["photo"]["id"] == photo["id"]
            assert [p["id"] for p in client.photos(album_id)] == [p["id"] for p in photos]
            print(f"T15 restored album: {len(photos)} originals", flush=True)
        assert client.call("GET", "/me/atlas")["photo_count"] == 3000
        assert client.call("GET", "/trash/photos")["photo_count"] == 0
        report = {
            "seconds": time.perf_counter() - start,
            "trash_members": len(seen),
            "restored": 3000,
            "samples": {key: stats(value) for key, value in measured.items()},
        }
        (ROOT / "lifecycle.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        assert report["samples"]["trash_first_page"]["p95_ms"] <= 1000
        print(json.dumps(report), flush=True)
    finally:
        client.close()
        other.close()


def maintenance():
    """After server shutdown, measure real cleanup with the production OS lock."""
    from dataclasses import asdict

    from city_memories.auth import AuthService
    from city_memories.cleanup import CleanupService, InstanceLock
    from city_memories.config import Settings
    from city_memories.database import build_engine
    from city_memories.imports import ImportService

    state = isolated_state()
    directory = Path(state["data_dir"])
    settings = Settings(
        data_dir=directory, _env_file=None, auth_secret=None, map_key=None, map_key_file=None
    )
    elapsed, reports = [], []
    with InstanceLock(directory):
        engine = build_engine(settings)
        try:
            cleanup = CleanupService(ImportService(AuthService(engine, settings)))
            assert len(list(settings.originals_dir.iterdir())) == 3400
            for _ in range(30):
                start = time.perf_counter()
                report = asdict(cleanup.run_once())
                elapsed.append((time.perf_counter() - start) * 1000)
                assert not report["busy"] and not report["failures"]
                assert report["photos_removed"] == report["files_removed"] == 0
                reports.append(report)
        finally:
            engine.dispose()
    result = {"original_files": 3400, "cycles": 30, "timings": stats(elapsed), "reports": reports}
    (ROOT / "maintenance.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "reports"}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=["populate", "benchmark", "lifecycle", "maintenance", "audit"]
    )
    arguments = parser.parse_args()
    {
        "populate": populate,
        "benchmark": benchmark,
        "lifecycle": lifecycle,
        "maintenance": maintenance,
        "audit": audit,
    }[arguments.action]()
