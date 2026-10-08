"""Distinct synthetic originals for T15; never reads user images or configuration."""

import argparse
import hashlib
import json
import random
import shutil
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent / "results"
SEED = 20261008


def generate(index: int, output: Path) -> dict:
    kind = index % 10
    fmt = "PNG" if kind == 8 else "WEBP" if kind == 9 else "JPEG"
    size = (4000, 3000) if kind == 0 else (2048, 1536) if kind == 8 else (2560, 1920)
    width, height = size
    rng = random.Random(SEED + index)
    # Unique texture over the whole image, not one picture renamed 3400 times.
    small = Image.frombytes(
        "RGB", (width // 4, height // 4), rng.randbytes(width // 4 * (height // 4) * 3)
    )
    image = small.resize(size, Image.Resampling.BILINEAR)
    small.close()
    draw = ImageDraw.Draw(image)
    for _ in range(12):
        x, y = rng.randrange(width), rng.randrange(height)
        draw.rectangle(
            (x, y, min(width, x + width // 8), min(height, y + height // 8)),
            fill=tuple(rng.randrange(256) for _ in range(3)),
        )
    draw.rectangle((20, 20, width - 20, 110), fill="#fff3d9")
    draw.text(
        (40, 40),
        f"T15 SYNTHETIC ORIGINAL {index + 1:04} - NO PRIVATE PHOTO",
        fill="#392f27",
        font_size=36,
    )
    extension = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}[fmt]
    name = f"26-{index + 1:04}.{extension}"
    path = output / name
    options = (
        {"quality": 88}
        if fmt == "JPEG"
        else {"compress_level": 1}
        if fmt == "PNG"
        else {"quality": 85, "method": 0}
    )
    image.save(path, format=fmt, **options)
    image.close()
    content = path.read_bytes()
    return {
        "index": index,
        "name": name,
        "format": fmt,
        "width": width,
        "height": height,
        "byte_size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=3400, choices=[10, 3400])
    args = parser.parse_args()
    output = ROOT / f"fixtures-{args.count}"
    manifest_path = output / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["seed"] == SEED and len(manifest["items"]) == args.count
        for item in manifest["items"]:
            path = output / item["name"]
            assert path.stat().st_size == item["byte_size"]
            with path.open("rb") as stream:
                assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]
        print(
            json.dumps({"reused_verified_fixtures": args.count, "summary": manifest["summary"]}),
            flush=True,
        )
        return
    ROOT.mkdir(parents=True, exist_ok=True)
    assert shutil.disk_usage(ROOT).free > (40 if args.count == 3400 else 1) * 1024**3
    # No overwrite/delete/resume of an unknown or partial directory.
    output.mkdir(exist_ok=False)
    started = time.monotonic()
    items = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for item in pool.map(lambda i: generate(i, output), range(args.count)):
            items.append(item)
            if len(items) % 100 == 0:
                print(
                    f"Generated {len(items)}/{args.count} distinct synthetic originals", flush=True
                )
    assert len({item["sha256"] for item in items}) == args.count
    assert all(0 < item["byte_size"] <= 50 * 1024**2 for item in items)
    sizes = sorted(item["byte_size"] for item in items)
    summary = {
        "count": len(items),
        "formats": dict(Counter(item["format"] for item in items)),
        "resolutions": dict(Counter(f"{i['width']}x{i['height']}" for i in items)),
        "bytes": sum(sizes),
        "min_bytes": sizes[0],
        "median_bytes": sizes[len(sizes) // 2],
        "max_bytes": sizes[-1],
        "generation_seconds": round(time.monotonic() - started, 3),
    }
    manifest_path.write_text(
        json.dumps(
            {"schema": 1, "synthetic": True, "seed": SEED, "summary": summary, "items": items},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
