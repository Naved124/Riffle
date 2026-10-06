"""Render the MSIX (Microsoft Store) tile and icon images from the app icon.

    python3 tools/render_msix_assets.py      # needs Pillow

Writes packaging/windows/msix/Assets/. Each logo comes in scale-100 and scale-200 sizes, and the
44x44 app icon also in the taskbar "targetsize" sizes; makepri (in make-msix.ps1) indexes them.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON = Image.open(ROOT / "packaging" / "icons" / "icon-1024.png").convert("RGBA")
OUT = ROOT / "packaging" / "windows" / "msix" / "Assets"


def icon(size: int) -> Image.Image:
    return ICON.resize((size, size), Image.LANCZOS)


def tile(w: int, h: int, fill: float) -> Image.Image:
    """The icon centred on a transparent image, taking `fill` of the shorter side (Windows draws the
    tile or splash-screen colour behind it)."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    s = int(min(w, h) * fill)
    img.alpha_composite(icon(s), ((w - s) // 2, (h - s) // 2))
    return img


def save(img: Image.Image, name: str) -> None:
    img.save(OUT / name, optimize=True)


OUT.mkdir(parents=True, exist_ok=True)
for old in OUT.glob("*.png"):
    old.unlink()
for scale in (100, 200):
    f = scale / 100
    save(icon(round(44 * f)), f"Square44x44Logo.scale-{scale}.png")
    save(icon(round(50 * f)), f"StoreLogo.scale-{scale}.png")
    save(tile(round(71 * f), round(71 * f), 0.9), f"Square71x71Logo.scale-{scale}.png")
    save(tile(round(150 * f), round(150 * f), 0.8), f"Square150x150Logo.scale-{scale}.png")
    save(tile(round(310 * f), round(150 * f), 0.8), f"Wide310x150Logo.scale-{scale}.png")
    save(tile(round(310 * f), round(310 * f), 0.8), f"Square310x310Logo.scale-{scale}.png")
    save(tile(round(620 * f), round(300 * f), 0.75), f"SplashScreen.scale-{scale}.png")
for size in (16, 24, 32, 48, 256):
    save(icon(size), f"Square44x44Logo.targetsize-{size}.png")
    save(icon(size), f"Square44x44Logo.targetsize-{size}_altform-unplated.png")
print(len(list(OUT.glob("*.png"))), "images in", OUT)
