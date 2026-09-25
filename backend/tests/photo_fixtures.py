"""Small synthetic originals for isolated T05 tests; never used by the application."""

import hashlib
import io
from uuid import uuid4

from PIL import Image, ImageDraw

from city_memories.imports import CommitInput, ImportInput


def seed_photos(app, owner: str, album_id: str, count: int = 27):
    service = app.state.imports
    contents = []
    for index in range(count):
        image = Image.new("RGB", (720, 480), (234, 218 - index % 20, 183))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 270, 720, 480), fill=(115 + index % 25, 146, 129))
        draw.ellipse((490, 65, 600, 175), fill=(182, 116 + index % 20, 75))
        draw.text(
            (40, 420), f"SYNTHETIC ORIGINAL {index + 1:02} - NO PRIVATE PHOTO", fill=(43, 62, 48)
        )
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        contents.append(stream.getvalue())
    metadata = [
        {
            "original_filename": f"journey-{index + 1:02}.png",
            "byte_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        for index, content in enumerate(contents)
    ]
    batch, _ = service.create(album_id, owner, str(uuid4()), ImportInput(items=metadata))
    for item, content in zip(batch["items"], contents, strict=True):
        upload, token = service.begin_upload(batch["id"], item["id"], owner)
        service.receive(batch["id"], upload, owner, token, io.BytesIO(content))
    result = service.commit(
        batch["id"], owner, CommitInput(expected_album_revision=batch["album_revision"])
    )
    return result["photo_ids"], contents
