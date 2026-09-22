"""Private, byte-preserving storage. Never derive a path from an uploaded filename."""

import hashlib
import os
import re
from pathlib import Path
from typing import BinaryIO

from PIL import Image, UnidentifiedImageError

from city_memories.errors import ApiError

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_PIXELS = 80_000_000
CHUNK_SIZE = 256 * 1024
MIME_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


def private_path(directory: Path, key: str, attempt: str | None = None) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", key) or (
        attempt is not None and not re.fullmatch(r"[a-f0-9]{32}", attempt)
    ):
        raise ApiError(503, "STORAGE_UNAVAILABLE", "原图存储暂不可用")
    root = directory.resolve()
    path = root / (f"{key}.{attempt}.part" if attempt else key)
    if path.is_symlink() or path.resolve().parent != root:
        raise ApiError(503, "STORAGE_UNAVAILABLE", "原图存储暂不可用")
    return path


def write_and_validate(stream: BinaryIO, target: Path, expected_bytes: int, expected_hash: str):
    digest = hashlib.sha256()
    size = 0
    with target.open("xb") as output:
        while chunk := stream.read(CHUNK_SIZE):
            size += len(chunk)
            if size > min(expected_bytes, MAX_FILE_BYTES):
                raise ApiError(413, "FILE_TOO_LARGE", "图片超过声明大小或 50 MiB 上限")
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    if size != expected_bytes or digest.hexdigest() != expected_hash:
        raise ApiError(422, "FILE_MISMATCH", "文件大小或内容与所选文件不一致，请重新核对")
    try:
        with Image.open(target) as picture:
            if picture.format not in MIME_TYPES or getattr(picture, "n_frames", 1) != 1:
                raise ApiError(415, "UNSUPPORTED_IMAGE", "只支持 JPEG、PNG 和静态 WebP，不支持动画")
            width, height = picture.size
            if width * height > MAX_PIXELS:
                raise ApiError(413, "IMAGE_TOO_LARGE", "图片超过 8000 万像素上限")
            mime = MIME_TYPES[picture.format]
            picture.verify()
        with Image.open(target) as picture:
            picture.load()  # Decode for validation only; never re-encode or modify.
    except Image.DecompressionBombError as exc:
        raise ApiError(413, "IMAGE_TOO_LARGE", "图片像素过大") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ApiError(415, "INVALID_IMAGE", "文件不是支持的完整图片，或图片已损坏") from exc
    return {
        "actual_bytes": size,
        "sha256": digest.hexdigest(),
        "mime_type": mime,
        "width": width,
        "height": height,
    }


def matches(path: Path, byte_size: int, digest: str) -> bool:
    if not path.is_file() or path.stat().st_size != byte_size:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == digest


def remove_temporary(path: Path) -> None:
    # One resolved, server-generated file only. A failed cleanup keeps metadata
    # available for T10; it must never remove an unrelated directory or source.
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
