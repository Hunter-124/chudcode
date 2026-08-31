#!/usr/bin/env python3
"""Chudcode GUI icon atlas generator.

Deterministic, procedural PIL line art only — no third-party artwork, no
photographs, no fonts. Pipeline *pattern* follows the proven CAD icon
pipeline (CAD:contracts/icons.md): every glyph is drawn at 8x supersample,
downsampled LANCZOS, packed into TWO theme atlases (dark + light) that share
ONE layout, so a theme switch swaps textures with identical UVs. The
*inventory* is Chudcode IDE-domain and deliberately disjoint from CAD's.

Outputs (committed, diffable — no timestamps anywhere):
    gui/assets/icons/atlas_dark.png
    gui/assets/icons/atlas_light.png
    gui/assets/icons/atlas.json

PNG encoding is deliberately stored-deflate (zlib level 0, filter 0 on every
scanline): the C++ loader (gui/src/icons/icons.cpp) then needs no zlib — it
walks stored blocks and strips filter bytes. Standard viewers read the files
normally; they are just uncompressed.

Adding an icon = add a draw function + append its name LAST to ICON_NAMES so
every pre-existing cell keeps its UVs. Layout is computed, never hand-packed.

    python3 gui/scripts/make_icons.py           # regenerate
    python3 gui/scripts/make_icons.py --verify  # byte-compare against disk
"""

from __future__ import annotations

import json
import math
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent  # gui/
OUT_DIR = ROOT / "assets" / "icons"

# Append-only. Names and UVs stay stable; glyph redraws are free.
ICON_NAMES = [
    "send", "stop", "attach", "new-session", "close-tab",
    "open-folder", "agent", "task", "tool", "recovery",
    "pin", "fork", "rename", "delete", "git-branch",
    "git-commit", "terminal", "diff", "settings", "usage",
]

CELL_SIZES = (32, 20)   # packing order: 32-band first, then 20-band
SS = 8                  # supersample factor
PAD = 2                 # inter-cell gutter, prevents sampler bleed
COLS = 8


class Palette:
    """Baked stroke colors, keyed by the SEMANTIC theme role they mirror.

    The C++ side never hardcodes colors: atlases are theme-baked and drawn
    with an identity tint; callers may re-tint via palette roles only.
    """

    def __init__(self, text, dim, accent, accent2, ok, warn, err):
        self.text = text        # ui::Palette::text
        self.dim = dim          # ui::Palette::textDim
        self.accent = accent    # ui::Palette::accent (primary)
        self.accent2 = accent2  # ui::Palette::secondary
        self.ok = ok            # ui::Palette::statusOk
        self.warn = warn        # ui::Palette::statusWarn
        self.err = err          # ui::Palette::statusErr

    def roles(self):
        return {
            "text": _hex(self.text), "textDim": _hex(self.dim),
            "accent": _hex(self.accent), "secondary": _hex(self.accent2),
            "statusOk": _hex(self.ok), "statusWarn": _hex(self.warn),
            "statusErr": _hex(self.err),
        }


def _hex(c):
    return "#%02X%02X%02X" % c


# Values mirror gui/src/theme/theme.cpp so glyphs sit on theme surfaces
# without per-draw tinting. Where a role cannot survive as a 2 px hairline
# (contrast), the baked value is DERIVED, not reused, and noted here:
#  - light accent  #C25E05: primary #F28216 deepened (2.4:1 on white fails)
#  - light accent2 #005CA6: secondary #0078D7 deepened for hairline contrast
#  - dark accent2  #3D9BE9: secondary #0078D7 brightened for dark surfaces
DARK = Palette(
    text=(229, 234, 241),    # #E5EAF1
    dim=(158, 168, 184),     # #9EA8B8
    accent=(242, 130, 22),   # #F28216
    accent2=(61, 155, 233),  # #3D9BE9 (derived, see above)
    ok=(117, 219, 140),      # #75DB8C
    warn=(243, 194, 107),    # #F3C26B
    err=(245, 140, 107),     # #F58C6B
)
LIGHT = Palette(
    text=(31, 36, 48),       # #1F2430
    dim=(83, 92, 108),       # #535C6C
    accent=(194, 94, 5),     # #C25E05 (derived, see above)
    accent2=(0, 92, 166),    # #005CA6 (derived, see above)
    ok=(37, 142, 69),        # #258E45
    warn=(174, 113, 10),     # #AE710A
    err=(196, 65, 49),       # #C44131
)

LW = 2 * SS               # 2 px-equivalent stroke at final resolution
THIN = max(1, int(1.2 * SS))

_REGISTRY: dict[str, callable] = {}


def icon(name):
    def decorator(fn):
        _REGISTRY[name] = fn
        return fn
    return decorator


# ---------------------------------------------------------------------------
# draw helpers (supersampled canvas, coordinates are fractions of s)

def _a(color, alpha):
    return (color[0], color[1], color[2], alpha)


def line(d, s, p0, p1, color, lw=LW):
    d.line([(p0[0] * s, p0[1] * s), (p1[0] * s, p1[1] * s)], fill=color, width=lw)


def poly(d, s, pts, outline=None, fill=None, lw=LW):
    d.polygon([(x * s, y * s) for x, y in pts], outline=outline, fill=fill, width=lw)


def circle(d, s, cx, cy, r, outline=None, fill=None, lw=LW):
    bb = [(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s]
    d.ellipse(bb, outline=outline, fill=fill, width=lw)


def arc(d, s, cx, cy, r, a0, a1, color, lw=LW):
    bb = [(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s]
    d.arc(bb, start=a0, end=a1, fill=color, width=lw)


def rrect(d, s, x0, y0, x1, y1, rad, outline=None, fill=None, lw=LW):
    d.rounded_rectangle([x0 * s, y0 * s, x1 * s, y1 * s], radius=rad * s,
                        outline=outline, fill=fill, width=lw)


def arrow_head(d, s, tip, angle_deg, size, color):
    a = math.radians(angle_deg)
    left = (tip[0] - size * math.cos(a - 0.5), tip[1] - size * math.sin(a - 0.5))
    right = (tip[0] - size * math.cos(a + 0.5), tip[1] - size * math.sin(a + 0.5))
    poly(d, s, [tip, left, right], fill=color)


# ---------------------------------------------------------------------------
# inventory — one draw function per name; result/action, not generic emblem

@icon("send")
def draw_send(d, s, p):
    """Paper plane, nose right; accent fold line marks the throw direction."""
    poly(d, s, [(0.10, 0.16), (0.92, 0.50), (0.10, 0.84), (0.28, 0.50)],
         outline=p.text, lw=LW)
    line(d, s, (0.28, 0.50), (0.88, 0.50), p.accent, LW)


@icon("stop")
def draw_stop(d, s, p):
    """Interrupt a running turn: ring + solid err square (media-stop)."""
    circle(d, s, 0.5, 0.5, 0.40, outline=p.text)
    rrect(d, s, 0.35, 0.35, 0.65, 0.65, 0.05, fill=p.err)


@icon("attach")
def draw_attach(d, s, p):
    """Paperclip: outer wire + shorter inner accent wire."""
    line(d, s, (0.34, 0.22), (0.34, 0.66), p.text)
    arc(d, s, 0.50, 0.66, 0.16, 0, 180, p.text)
    line(d, s, (0.66, 0.66), (0.66, 0.26), p.text)
    arc(d, s, 0.55, 0.26, 0.11, 180, 360, p.text)
    line(d, s, (0.44, 0.26), (0.44, 0.58), p.accent)


@icon("new-session")
def draw_new_session(d, s, p):
    """Chat bubble with an accent plus: start a fresh conversation."""
    rrect(d, s, 0.12, 0.16, 0.88, 0.70, 0.10, outline=p.text)
    poly(d, s, [(0.26, 0.70), (0.26, 0.88), (0.44, 0.70)], fill=p.text)
    line(d, s, (0.38, 0.43), (0.62, 0.43), p.accent)
    line(d, s, (0.50, 0.31), (0.50, 0.55), p.accent)


@icon("close-tab")
def draw_close_tab(d, s, p):
    """Editor tab silhouette (dim) with a bold X."""
    d.rounded_rectangle([0.10 * s, 0.22 * s, 0.90 * s, 0.78 * s], radius=0.08 * s,
                        outline=p.dim, width=LW, corners=(True, True, False, False))
    line(d, s, (0.10, 0.78), (0.90, 0.78), p.dim)
    line(d, s, (0.38, 0.38), (0.62, 0.62), p.text)
    line(d, s, (0.62, 0.38), (0.38, 0.62), p.text)


@icon("open-folder")
def draw_open_folder(d, s, p):
    """Open folder: back panel + tilted accent-washed front flap."""
    poly(d, s, [(0.10, 0.26), (0.38, 0.26), (0.46, 0.36), (0.86, 0.36),
                (0.86, 0.46), (0.10, 0.46)], outline=p.text, lw=THIN)
    poly(d, s, [(0.18, 0.46), (0.94, 0.46), (0.82, 0.80), (0.08, 0.80)],
         outline=p.text, fill=_a(p.accent, 70), lw=LW)


@icon("agent")
def draw_agent(d, s, p):
    """Agent: robot head, accent eyes, antenna."""
    rrect(d, s, 0.20, 0.34, 0.80, 0.80, 0.10, outline=p.text)
    circle(d, s, 0.38, 0.57, 0.055, fill=p.accent)
    circle(d, s, 0.62, 0.57, 0.055, fill=p.accent)
    line(d, s, (0.50, 0.34), (0.50, 0.20), p.text)
    circle(d, s, 0.50, 0.16, 0.05, fill=p.accent)


@icon("task")
def draw_task(d, s, p):
    """Task card: sheet with an ok check and remaining dim lines."""
    rrect(d, s, 0.20, 0.12, 0.80, 0.88, 0.08, outline=p.text)
    line(d, s, (0.32, 0.36), (0.42, 0.46), p.ok)
    line(d, s, (0.42, 0.46), (0.62, 0.24), p.ok)
    line(d, s, (0.32, 0.60), (0.68, 0.60), p.dim)
    line(d, s, (0.32, 0.72), (0.60, 0.72), p.dim)


@icon("tool")
def draw_tool(d, s, p):
    """Wrench: heavy C-jaw open toward the upper-left + thick round-capped
    handle to the lower-right, accent glint on the jaw."""
    heavy = int(LW * 2.2)
    arc(d, s, 0.34, 0.34, 0.19, 265, 185, p.text, lw=heavy)
    line(d, s, (0.45, 0.45), (0.78, 0.78), p.text, lw=heavy)
    circle(d, s, 0.78, 0.78, 0.075, fill=p.text)
    arc(d, s, 0.34, 0.34, 0.19, 300, 340, p.accent, lw=heavy)


@icon("recovery")
def draw_recovery(d, s, p):
    """Session recovery: counter-clockwise ring arrow around clock hands."""
    arc(d, s, 0.5, 0.5, 0.36, -60, 210, p.text)
    arrow_head(d, s, (0.5 + 0.36 * math.cos(math.radians(210)),
                      0.5 + 0.36 * math.sin(math.radians(210))), 120, 0.14, p.text)
    line(d, s, (0.5, 0.5), (0.5, 0.32), p.accent)
    line(d, s, (0.5, 0.5), (0.62, 0.58), p.accent)


@icon("pin")
def draw_pin(d, s, p):
    """Map pin: ring head, accent core, tail to the anchor point."""
    circle(d, s, 0.5, 0.38, 0.22, outline=p.text)
    circle(d, s, 0.5, 0.38, 0.07, fill=p.accent)
    line(d, s, (0.5, 0.60), (0.5, 0.86), p.text)


@icon("fork")
def draw_fork(d, s, p):
    """Fork a session: one trunk splitting toward two arrowheads."""
    line(d, s, (0.50, 0.86), (0.50, 0.54), p.text)
    line(d, s, (0.50, 0.54), (0.28, 0.26), p.text)
    line(d, s, (0.50, 0.54), (0.72, 0.26), p.text)
    arrow_head(d, s, (0.28, 0.26), 232, 0.13, p.text)
    arrow_head(d, s, (0.72, 0.26), 308, 0.13, p.text)
    circle(d, s, 0.50, 0.54, 0.06, fill=p.accent)


@icon("rename")
def draw_rename(d, s, p):
    """Rename: pencil over a dim baseline, accent tip touching it."""
    line(d, s, (0.12, 0.84), (0.88, 0.84), p.dim)
    line(d, s, (0.34, 0.66), (0.78, 0.22), p.text, lw=int(LW * 1.6))
    poly(d, s, [(0.30, 0.70), (0.24, 0.80), (0.36, 0.76)], fill=p.accent)


@icon("delete")
def draw_delete(d, s, p):
    """Trash can with lid and ribs."""
    line(d, s, (0.20, 0.28), (0.80, 0.28), p.text)
    line(d, s, (0.40, 0.28), (0.44, 0.18), p.text, lw=THIN)
    line(d, s, (0.60, 0.28), (0.56, 0.18), p.text, lw=THIN)
    poly(d, s, [(0.28, 0.36), (0.72, 0.36), (0.66, 0.84), (0.34, 0.84)],
         outline=p.text, lw=LW)
    line(d, s, (0.44, 0.46), (0.45, 0.74), p.dim, lw=THIN)
    line(d, s, (0.56, 0.46), (0.55, 0.74), p.dim, lw=THIN)


@icon("git-branch")
def draw_git_branch(d, s, p):
    """Branch: trunk with two nodes, curve to an accent branch node."""
    line(d, s, (0.30, 0.26), (0.30, 0.76), p.text)
    circle(d, s, 0.30, 0.20, 0.075, outline=p.text)
    circle(d, s, 0.30, 0.82, 0.075, outline=p.text)
    arc(d, s, 0.30 + 0.38, 0.52, 0.38, 180, 270, p.text)
    circle(d, s, 0.68, 0.28, 0.075, outline=p.accent)


@icon("git-commit")
def draw_git_commit(d, s, p):
    """Commit: node on the history line."""
    line(d, s, (0.06, 0.50), (0.30, 0.50), p.text)
    line(d, s, (0.70, 0.50), (0.94, 0.50), p.text)
    circle(d, s, 0.50, 0.50, 0.16, outline=p.accent)


@icon("terminal")
def draw_terminal(d, s, p):
    """Terminal: frame, accent prompt chevron, cursor underscore."""
    rrect(d, s, 0.10, 0.18, 0.90, 0.82, 0.08, outline=p.text)
    line(d, s, (0.24, 0.40), (0.38, 0.52), p.accent)
    line(d, s, (0.38, 0.52), (0.24, 0.64), p.accent)
    line(d, s, (0.46, 0.64), (0.66, 0.64), p.text)


@icon("diff")
def draw_diff(d, s, p):
    """Diff: split sheet, ok plus on the left, err minus on the right."""
    rrect(d, s, 0.12, 0.16, 0.88, 0.84, 0.08, outline=p.text)
    for i in range(4):
        y0 = 0.24 + i * 0.15
        line(d, s, (0.50, y0), (0.50, y0 + 0.08), p.dim, lw=THIN)
    line(d, s, (0.24, 0.50), (0.40, 0.50), p.ok)
    line(d, s, (0.32, 0.42), (0.32, 0.58), p.ok)
    line(d, s, (0.60, 0.50), (0.76, 0.50), p.err)


@icon("settings")
def draw_settings(d, s, p):
    """Gear: ring, radial teeth, accent hub."""
    circle(d, s, 0.5, 0.5, 0.24, outline=p.text)
    for i in range(8):
        a = math.radians(i * 45)
        line(d, s, (0.5 + 0.24 * math.cos(a), 0.5 + 0.24 * math.sin(a)),
             (0.5 + 0.38 * math.cos(a), 0.5 + 0.38 * math.sin(a)),
             p.text, lw=int(LW * 1.4))
    circle(d, s, 0.5, 0.5, 0.09, outline=p.accent)


@icon("usage")
def draw_usage(d, s, p):
    """Usage gauge: the §4 fraction-ring shape — dim track, accent fill."""
    arc(d, s, 0.5, 0.54, 0.34, 135, 45, p.dim)
    arc(d, s, 0.5, 0.54, 0.34, 135, 315, p.accent)
    circle(d, s, 0.5, 0.54, 0.05, fill=p.text)


# ---------------------------------------------------------------------------
# packing + encoding

def render_cell(name, cell, palette):
    s = cell * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    _REGISTRY[name](ImageDraw.Draw(img), s, palette)
    return img.resize((cell, cell), Image.Resampling.LANCZOS)


def pack_layout():
    """One computed layout shared by both atlases. Returns (cells, w, h)."""
    cells = {}
    atlas_w = PAD + COLS * (32 + PAD)
    y = PAD
    for size in CELL_SIZES:
        for i, name in enumerate(ICON_NAMES):
            col, row = i % COLS, i // COLS
            cells[f"{name}@{size}"] = {
                "x": PAD + col * (size + PAD),
                "y": y + row * (size + PAD),
                "w": size, "h": size,
            }
        rows = (len(ICON_NAMES) + COLS - 1) // COLS
        y += rows * (size + PAD)
    return cells, atlas_w, y


def compose_atlas(cells, w, h, palette):
    atlas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for size in CELL_SIZES:
        for name in ICON_NAMES:
            c = cells[f"{name}@{size}"]
            atlas.paste(render_cell(name, size, palette), (c["x"], c["y"]))
    return atlas


def png_bytes(image):
    """Minimal PNG writer: 8-bit RGBA, filter 0, stored-deflate IDAT.

    zlib level 0 emits only stored (uncompressed) deflate blocks, which is
    the entire reason gui/src/icons/icons.cpp can decode these files without
    a zlib dependency. Do not 'optimize' this to a compressed level.
    """
    w, h = image.size
    raw = image.tobytes()
    stride = w * 4
    scan = b"".join(b"\x00" + raw[y * stride:(y + 1) * stride] for y in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scan, 0))
            + chunk(b"IEND", b""))


def atlas_json_bytes(cells, w, h):
    doc = {
        "schema": "chudcode-icons-v1",
        "generator": "gui/scripts/make_icons.py",
        "inputs": "procedural PIL line art only; no third-party artwork, "
                  "no photographs, no fonts",
        "license": "in-house: generated in this repository; no external assets",
        "pattern_provenance": "pipeline shape after CAD:contracts/icons.md "
                              "(deterministic dual-theme atlases, one shared "
                              "layout); inventory is Chudcode IDE-domain",
        "png_encoding": "stored-deflate (zlib level 0), filter 0 scanlines",
        "supersample": SS,
        "cell_sizes": sorted(CELL_SIZES),
        "names": ICON_NAMES,
        "palette": {"dark": DARK.roles(), "light": LIGHT.roles()},
        "atlas_px": [w, h],
        "cell": cells,
    }
    return (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode()


def generate():
    cells, w, h = pack_layout()
    missing = [n for n in ICON_NAMES if n not in _REGISTRY]
    if missing:
        raise SystemExit(f"no draw function for: {missing}")
    return {
        "atlas_dark.png": png_bytes(compose_atlas(cells, w, h, DARK)),
        "atlas_light.png": png_bytes(compose_atlas(cells, w, h, LIGHT)),
        "atlas.json": atlas_json_bytes(cells, w, h),
    }


def main():
    outputs = generate()
    if "--verify" in sys.argv[1:]:
        bad = [n for n, data in outputs.items()
               if not (OUT_DIR / n).is_file() or (OUT_DIR / n).read_bytes() != data]
        if bad:
            print(f"STALE: {bad} differ from a fresh regeneration", file=sys.stderr)
            raise SystemExit(1)
        print(f"verify OK: {len(outputs)} files match a fresh regeneration")
        return
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (OUT_DIR / name).write_bytes(data)
        print(f"wrote {(OUT_DIR / name).relative_to(ROOT)} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
