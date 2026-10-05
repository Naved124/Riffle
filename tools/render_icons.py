"""Render the app icon (flashcard_viewer/ui/icon.svg) to PNG/ICO for Windows and Android.

    QT_QPA_PLATFORM=offscreen python3 tools/render_icons.py
"""
import subprocess
import sys
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QGuiApplication, QImage, QPainter
from PyQt6.QtSvg import QSvgRenderer

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "flashcard_viewer" / "ui" / "icon.svg"

app = QGuiApplication(sys.argv)
renderer = QSvgRenderer(str(SVG))


def render(size: int, out: Path, inset: float = 0.0, bg=None) -> None:
    img = QImage(size, size, QImage.Format.Format_ARGB32)
    img.fill(Qt.GlobalColor.transparent if bg is None else bg)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    m = size * inset
    from PyQt6.QtCore import QRectF
    renderer.render(p, QRectF(m, m, size - 2 * m, size - 2 * m))
    p.end()
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out))


# Windows .ico (multi-size)
tmp = ROOT / "build" / "icons"
sizes = [16, 24, 32, 48, 64, 128, 256]
for s in sizes:
    render(s, tmp / f"{s}.png")
subprocess.run(["convert", *[str(tmp / f"{s}.png") for s in sizes], str(ROOT / "packaging/windows/flashcard-viewer.ico")], check=True)

# Android launcher icons (legacy) + adaptive foreground
res = ROOT / "android/app/src/main/res"
for name, s in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    render(s, res / f"mipmap-{name}/ic_launcher.png")
    # adaptive-icon foreground is 108dp with a 72dp safe zone
    render(int(s * 108 / 48), res / f"mipmap-{name}/ic_launcher_foreground.png", inset=0.17)
render(512, ROOT / "packaging/icons/flashcard-viewer-512.png")
print("icons written")
