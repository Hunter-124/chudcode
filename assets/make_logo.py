#!/usr/bin/env python3
"""Generate every Chudcode product icon from one vector mark."""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
APPICON_DIR = ROOT / "appicon"
DOCS_DIR = ROOT / "docs"
SIZES = (16, 24, 32, 48, 64, 128, 256)
ICON_SIZES = (16, 32, 48, 64, 128, 256)
SS = 4

TILE_TOP = "#1E222C"
TILE_BOTTOM = "#0E1016"
TEAL_HI = "#42ECCE"
TEAL = "#30D8BE"
TEAL_MID = "#22BEAA"
TEAL_DK = "#108073"
SPARK = "#EBFFFA"


def _rgb(color: str) -> tuple[int, int, int]:
    value = color.removeprefix("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def _scaled(points: list[tuple[float, float]], cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    return [(cx + x * r, cy + y * r) for x, y in points]


def draw_mark(
    img: Image.Image,
    cx: float,
    cy: float,
    r: float,
    spark: bool = True,
    on_light: bool = False,
) -> None:
    """Draw the shared faceted code-gate mark onto an RGBA image.

    All output assets call this function. Geometry changes by final pixel tier so
    the 16/24 px icons remain a deliberate native render, not a reduced master.
    """

    draw = ImageDraw.Draw(img)
    final_size = int(img.info.get("final_size", img.width))
    simple = final_size <= 24
    compact = final_size <= 32

    if on_light:
        left_base, right_base = TEAL_DK, TEAL_MID
        left_hi, right_hi = TEAL_MID, TEAL
    else:
        left_base, right_base = TEAL_MID, TEAL_DK
        left_hi, right_hi = TEAL_HI, TEAL

    extent = 0.72 if simple else 0.78
    shoulder = 0.46 if compact else 0.34
    inner_edge = 0.20 if compact else 0.13
    elbow = 0.50 if compact else 0.52
    top = 0.53 if simple else 0.58

    # Outward-facing angle brackets make the coding identity explicit. Their
    # inner elbows frame a central cell reserved for the Chudware spark.
    left = [
        (-extent, 0.0),
        (-shoulder, -top),
        (-inner_edge, -top),
        (-elbow, 0.0),
        (-inner_edge, top),
        (-shoulder, top),
    ]
    right = [(-x, y) for x, y in left]
    draw.polygon(_scaled(left, cx, cy, r), fill=left_base)
    draw.polygon(_scaled(right, cx, cy, r), fill=right_base)

    if not simple:
        left_top = [(-extent, 0.0), (-shoulder, -top), (-inner_edge, -top), (-elbow, 0.0)]
        right_top = [(-x, y) for x, y in left_top]
        draw.polygon(_scaled(left_top, cx, cy, r), fill=left_hi)
        draw.polygon(_scaled(right_top, cx, cy, r), fill=right_hi)

    spark_diameter_final = (0.35 * r) / float(img.info.get("ss", 1))
    if spark and spark_diameter_final >= 7.0:
        outer_radius = 0.175 * r
        inner_radius = 0.052 * r
        points: list[tuple[float, float]] = []
        for x, y in (
            (0.0, -outer_radius),
            (inner_radius, -inner_radius),
            (outer_radius, 0.0),
            (inner_radius, inner_radius),
            (0.0, outer_radius),
            (-inner_radius, inner_radius),
            (-outer_radius, 0.0),
            (-inner_radius, -inner_radius),
        ):
            points.append((cx + x, cy + y))
        draw.polygon(points, fill=SPARK)


def _rounded_gradient(size: int, radius: float) -> Image.Image:
    top = _rgb(TILE_TOP)
    bottom = _rgb(TILE_BOTTOM)
    gradient = Image.new("RGBA", (size, size))
    pixels = gradient.load()
    for y in range(size):
        mix = y / max(size - 1, 1)
        color = tuple(round(a + (b - a) * mix) for a, b in zip(top, bottom)) + (255,)
        for x in range(size):
            pixels[x, y] = color
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    gradient.putalpha(mask)
    return gradient


def make_tile(size: int) -> Image.Image:
    ss = 1 if size <= 24 else SS
    canvas_size = size * ss
    image = _rounded_gradient(canvas_size, canvas_size * 0.235)
    image.info["final_size"] = size
    image.info["ss"] = ss
    draw_mark(image, canvas_size * 0.5, canvas_size * 0.5, canvas_size * 0.385)
    if ss == 1:
        return image
    return image.resize((size, size), Image.Resampling.LANCZOS)

def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        Path("/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        Path("/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)


def make_wordmark() -> Image.Image:
    width, height = 1024, 256
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    tile = make_tile(200)
    image.alpha_composite(tile, (28, 28))

    draw = ImageDraw.Draw(image)
    font = _font(92)
    text = "Chudcode"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_height = bbox[3] - bbox[1]
    y = (height - text_height) // 2 - bbox[1]
    draw.text((258, y), "Chud", font=font, fill=SPARK)
    prefix_width = draw.textlength("Chud", font=font)
    draw.text((258 + prefix_width, y), "code", font=font, fill=TEAL)
    return image


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def write_ico(path: Path, images: dict[int, Image.Image]) -> None:
    frames = [(size, _png_bytes(images[size])) for size in ICON_SIZES]
    header_size = 6 + 16 * len(frames)
    offset = header_size
    entries: list[bytes] = []
    payloads: list[bytes] = []
    for size, payload in frames:
        dimension = 0 if size == 256 else size
        entries.append(
            struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(payload), offset)
        )
        payloads.append(payload)
        offset += len(payload)
    path.write_bytes(struct.pack("<HHH", 0, 1, len(frames)) + b"".join(entries) + b"".join(payloads))


def make_contact_sheet(images: dict[int, Image.Image]) -> Image.Image:
    cell_width = 280
    label_height = 48
    sheet = Image.new("RGBA", (cell_width * len(SIZES), 256 + label_height), (9, 11, 16, 255))
    draw = ImageDraw.Draw(sheet)
    font = _font(24)
    for index, size in enumerate(SIZES):
        scale = max(1, 256 // size)
        preview = images[size].resize((size * scale, size * scale), Image.Resampling.NEAREST)
        x = index * cell_width + (cell_width - preview.width) // 2
        y = (256 - preview.height) // 2
        sheet.alpha_composite(preview, (x, y))
        label = f"{size} x {size}"
        label_width = draw.textlength(label, font=font)
        draw.text((index * cell_width + (cell_width - label_width) / 2, 266), label, font=font, fill=SPARK)
    return sheet


def _save_png(path: Path, image: Image.Image) -> None:
    image.save(path, format="PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)} ({image.width}x{image.height})")


def main() -> None:
    APPICON_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    images = {size: make_tile(size) for size in SIZES}
    _save_png(ROOT / "logo_icon.png", images[256])
    for size in SIZES:
        _save_png(APPICON_DIR / f"{size}.png", images[size])

    write_ico(ROOT / "app.ico", images)
    print("wrote app.ico (16x16, 32x32, 48x48, 64x64, 128x128, 256x256 frames)")
    _save_png(ROOT / "logo_wordmark.png", make_wordmark())
    _save_png(DOCS_DIR / "icon-contact-sheet.png", make_contact_sheet(images))


if __name__ == "__main__":
    main()
