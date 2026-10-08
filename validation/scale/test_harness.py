import json

import harness
import pytest


def test_percentile_uses_nearest_rank():
    measured = harness.stats(list(range(1, 21)))
    assert measured == {"count": 20, "min_ms": 1, "median_ms": 10.5, "p95_ms": 19, "max_ms": 20}


@pytest.mark.parametrize("target", ["outside", "unmarked", "wrong-marker"])
def test_refuse_nonisolated_data_before_connecting(tmp_path, monkeypatch, target):
    results = tmp_path / "results"
    results.mkdir()
    directory = tmp_path / "outside" if target == "outside" else results / "t15-runtime-test"
    directory.mkdir()
    if target != "unmarked":
        (directory / "t15-isolated.txt").write_text(
            "wrong" if target == "wrong-marker" else "synthetic-only", encoding="utf-8"
        )
    (results / "server.json").write_text(
        json.dumps({"data_dir": str(directory), "identity": "test-only"}), encoding="utf-8"
    )
    monkeypatch.setattr(harness, "ROOT", results)
    with pytest.raises((AssertionError, FileNotFoundError)):
        harness.Client("Never_Connect")


def test_refuse_unrelated_localhost_server(tmp_path, monkeypatch):
    import httpx

    results = tmp_path / "results"
    directory = results / "t15-runtime-test"
    directory.mkdir(parents=True)
    (directory / "t15-isolated.txt").write_text("synthetic-only", encoding="utf-8")
    (results / "server.json").write_text(
        json.dumps({"data_dir": str(directory), "identity": "test-only"}), encoding="utf-8"
    )
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        return httpx.Response(200, json={"identity": "another-server"})

    with httpx.Client(base_url=harness.ORIGIN, transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(harness, "ROOT", results)
        monkeypatch.setattr(harness.httpx, "Client", lambda **kwargs: client)
        with pytest.raises(AssertionError):
            harness.Client("Never_Register", register=True)
    assert calls == [("GET", "/t15-isolated-identity")]
