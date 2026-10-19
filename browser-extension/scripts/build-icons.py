"""Build the PII Guard icons from the brand source image.

    python3 browser-extension/scripts/build-icons.py

Source: ``assets/brand/pii-guard-icon-source.png`` (1254x1254, a two-tone blue
shield with a person, on a solid black background). This script writes:

* ``browser-extension/icons/icon{16,32,48,128}.png`` -- the extension icons.
  The black background becomes transparent. The 128 px icon keeps the Chrome
  Web Store layout: 96x96 artwork with 16 px of transparent padding.
* ``assets/brand/store-icon-128.png`` -- the store listing icon (same as
  icon128.png, kept next to the source so the dashboard upload is obvious).
* ``assets/brand/pii-guard-logo.svg`` and the path data printed to stdout --
  the vector version used by the on-page toggle (composer-toggle.js), so the
  icon still draws when a site's CSP blocks images.

Why not a plain threshold: the navy parts (#012B6A) are only ~40 % as bright as
the blue ones, so treating "brightness" as opacity would make the person and the
right half of the shield translucent. Each pixel is instead unmixed as
``alpha * F + (1 - alpha) * black`` for whichever of the two brand colours F
fits best, which keeps both colours fully opaque and only the anti-aliased
edges partly transparent.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets/brand/pii-guard-icon-source.png"
ICONS = ROOT / "browser-extension/icons"
STORE_ICON = ROOT / "assets/brand/store-icon-128.png"
SVG_OUT = ROOT / "assets/brand/pii-guard-logo.svg"

BLUE = np.array([1, 118, 251], dtype=np.float64)   # left half of the shield
NAVY = np.array([1, 43, 106], dtype=np.float64)    # right half and the person


def unmix(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (colour, alpha, which) for an HxWx3 image over black.

    which: 0 = blue, 1 = navy (per pixel), alpha in [0, 1]."""
    best_res = None
    out_c = np.zeros_like(rgb)
    out_a = np.zeros(rgb.shape[:2])
    which = np.zeros(rgb.shape[:2], dtype=np.uint8)
    for k, f in enumerate((BLUE, NAVY)):
        a = np.clip((rgb @ f) / (f @ f), 0.0, 1.0)
        res = np.linalg.norm(rgb - a[..., None] * f, axis=-1)
        if best_res is None:
            best_res, out_a, which = res, a, np.full(a.shape, k, np.uint8)
            out_c[:] = f
        else:
            better = res < best_res
            best_res = np.where(better, res, best_res)
            out_a = np.where(better, a, out_a)
            which = np.where(better, k, which)
            out_c[better] = f
    return out_c, out_a, which


def artwork() -> tuple[Image.Image, np.ndarray]:
    """The source as transparent RGBA, cropped to the artwork's bounding box."""
    rgb = np.asarray(Image.open(SRC).convert("RGB"), dtype=np.float64)
    colour, alpha, which = unmix(rgb)
    # The source has a faint mottled texture: some navy pixels are ~15 % darker than
    # the reference, which unmixes to alpha ~0.85 and shows as pale blotches on a
    # light background. Only the anti-aliased edges should be partly transparent,
    # so map alpha 0.1..0.7 onto 0..1 (solid areas become fully opaque, the edge
    # ramp gets a little steeper) and drop the stray noise in the background.
    alpha = np.clip((alpha - 0.1) / 0.6, 0.0, 1.0)
    rgba = np.dstack([colour, alpha * 255.0]).round().clip(0, 255).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    box = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return img.crop(box), which[box[1]:box[3], box[0]:box[2]]


def fit(art: Image.Image, canvas: int, inner: int) -> Image.Image:
    """Scale ``art`` to fit an ``inner`` square, centred on a ``canvas`` square.

    Resampling is done on premultiplied alpha so the edges do not pick up a
    dark fringe from the (transparent) black, and with an area average (BOX)
    rather than LANCZOS, whose negative lobes leave a faint lighter ring just
    inside every edge when shrinking ~10x."""
    w, h = art.size
    scale = inner / max(w, h)
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    small = art.convert("RGBa").resize(size, Image.BOX).convert("RGBA")
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(small, ((canvas - size[0]) // 2, (canvas - size[1]) // 2), small)
    return out


def svg_paths(art: Image.Image, which: np.ndarray, view: float = 32.0, pad: float = 1.0) -> dict[str, str]:
    """Trace the blue and navy regions into SVG path data in a ``view`` box."""
    import cv2

    alpha = np.asarray(art.getchannel("A"))
    w, h = art.size
    scale = (view - 2 * pad) / max(w, h)
    ox = (view - w * scale) / 2
    oy = (view - h * scale) / 2
    paths = {}
    for k, name in ((0, "a"), (1, "b")):
        mask = ((alpha >= 128) & (which == k)).astype(np.uint8) * 255
        contours, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        parts = []
        for c in contours:
            if cv2.contourArea(c) < 400:  # specks
                continue
            c = cv2.approxPolyDP(c, 2.5, True).reshape(-1, 2)
            pts = [f"{ox + x * scale:.2f} {oy + y * scale:.2f}" for x, y in c]
            parts.append("M" + "L".join(pts) + "Z")
        paths[name] = "".join(parts)
    return paths


def main() -> int:
    art, which = artwork()
    ICONS.mkdir(parents=True, exist_ok=True)
    # 16/32/48: the artwork nearly fills the square (1 px margin at 32/48)
    for size, inner in ((16, 16), (32, 30), (48, 46)):
        fit(art, size, inner).save(ICONS / f"icon{size}.png", optimize=True)
    # 128: Chrome Web Store layout, 96x96 artwork + 16 px transparent padding
    icon128 = fit(art, 128, 96)
    icon128.save(ICONS / "icon128.png", optimize=True)
    icon128.save(STORE_ICON, optimize=True)
    paths = svg_paths(art, which)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        f'<path fill="#0176FB" fill-rule="evenodd" d="{paths["a"]}"/>'
        f'<path fill="#012B6A" fill-rule="evenodd" d="{paths["b"]}"/>'
        "</svg>\n"
    )
    SVG_OUT.write_text(svg, encoding="utf-8")
    print("a:", paths["a"])
    print("b:", paths["b"])
    print(f"wrote icons/icon{{16,32,48,128}}.png, {STORE_ICON.name}, {SVG_OUT.name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
