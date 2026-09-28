"""Generate placeholder 16/48/128 px icons for the browser extension.

Run inside the project runtime image where Pillow is already available:

    docker run --rm \
        -v "$PWD/browser-extension:/work" \
        -w /work \
        local-mask-mcp:latest \
        python scripts/generate-icons.py

Design choice: a solid blue square with a centered white ``M`` glyph.
We intentionally skip any font-file dependency (Pillow's ``ImageFont``
requires a TTF path on most systems) by drawing the glyph from simple
filled polygons. It is ugly but reproducible across hosts and does not
need a font to be baked into the Docker image.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

# Brand-neutral blue close to 37signals/macOS accent. Picked for
# contrast against both light and dark Chrome themes.
BG = (33, 102, 204, 255)
FG = (255, 255, 255, 255)


def draw_m(size: int) -> Image.Image:
    """Return an RGBA square of ``size`` px showing an ``M`` glyph."""
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)

    # Glyph geometry as fractions of ``size`` so every output stays
    # proportionally identical.
    pad = size * 0.22       # outer padding
    thick = size * 0.16     # stroke thickness
    top = pad
    bot = size - pad
    left = pad
    right = size - pad
    # Midpoint of the inner V (dips 45% of the way down).
    mid_x = size / 2
    mid_y = top + (bot - top) * 0.55

    # Left vertical bar.
    draw.rectangle([left, top, left + thick, bot], fill=FG)
    # Right vertical bar.
    draw.rectangle([right - thick, top, right, bot], fill=FG)
    # Left diagonal — top-left corner down to the midpoint.
    draw.polygon(
        [
            (left, top),
            (left + thick, top),
            (mid_x + thick * 0.5, mid_y),
            (mid_x - thick * 0.5, mid_y),
        ],
        fill=FG,
    )
    # Right diagonal — top-right corner down to the midpoint.
    draw.polygon(
        [
            (right - thick, top),
            (right, top),
            (mid_x + thick * 0.5, mid_y),
            (mid_x - thick * 0.5, mid_y),
        ],
        fill=FG,
    )
    return img


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        img = draw_m(size)
        img.save(out_dir / f"icon{size}.png", format="PNG")
        print(f"wrote {out_dir / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
