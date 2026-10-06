"""Render the app icon (packaging/icons/icon-1024.png) to every size the platforms need.

    QT_QPA_PLATFORM=offscreen python3 tools/render_icons.py

Writes flashcard_viewer/ui/icon.png (UI, window and Linux menu icon), the Windows .ico and the
Android launcher icons. Needs ImageMagick's `convert` for the .ico.
"""
import subprocess
import sys
from pathlib import Path

from PyQt6.QtCore import QRectF, Qt
from PyQt6.QtGui import QGuiApplication, QImage, QPainter

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "packaging" / "icons" / "icon-1024.png"

app = QGuiApplication(sys.argv)
source = QImage(str(MASTER))
assert not source.isNull(), f"can't read {MASTER}"


def render(size: int, out: Path, inset: float = 0.0) -> None:
    img = QImage(size, size, QImage.Format.Format_ARGB32)
    img.fill(Qt.GlobalColor.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
    m = size * inset
    # Scale in steps of at most 2x for clean downsampling to small sizes.
    src = source
    while src.width() / 2 >= size - 2 * m:
        src = src.scaled(src.width() // 2, src.height() // 2, Qt.AspectRatioMode.KeepAspectRatio,
                         Qt.TransformationMode.SmoothTransformation)
    p.drawImage(QRectF(m, m, size - 2 * m, size - 2 * m), src)
    p.end()
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out))


render(512, ROOT / "flashcard_viewer/ui/icon.png")
render(512, ROOT / "packaging/icons/flashcard-viewer-512.png")

# Windows .ico (multi-size)
tmp = ROOT / "build" / "icons"
sizes = [16, 24, 32, 48, 64, 128, 256]
for s in sizes:
    render(s, tmp / f"{s}.png")
subprocess.run(["convert", *[str(tmp / f"{s}.png") for s in sizes], str(ROOT / "packaging/windows/flashcard-viewer.ico")], check=True)

# Android: legacy launcher icons, plus the adaptive-icon foreground. That one is 108dp with only
# the middle ~72dp visible through the launcher's mask (a circle on many phones), so the tile is
# drawn at ~67dp to keep the cards and ring inside a circle. The gradient background
# (drawable/ic_launcher_background.xml) matches the tile's edges around it.
res = ROOT / "android/app/src/main/res"
for name, s in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    render(s, res / f"mipmap-{name}/ic_launcher.png")
    render(int(s * 108 / 48), res / f"mipmap-{name}/ic_launcher_foreground.png", inset=0.19)
print("icons written")
