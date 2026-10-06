# PyInstaller spec for the Windows build (also works on Linux for testing).
#   pyinstaller packaging/windows/flashcard-viewer.spec --noconfirm
import sys
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent.parent
ICON = ROOT / "packaging" / "windows" / "flashcard-viewer.ico"

a = Analysis(
    [str(ROOT / "packaging" / "windows" / "launcher.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "flashcard_viewer" / "ui"), "flashcard_viewer/ui")],
    hiddenimports=["PyQt6.QtWebEngineWidgets", "PyQt6.QtWebEngineCore", "PyQt6.QtWebChannel", "PyQt6.QtNetwork",
                   "PyQt6.QtSvg", "bs4"],
    excludes=["tkinter", "unittest", "pytest", "PyQt6.QtQuick3D", "PyQt6.QtBluetooth", "PyQt6.QtMultimedia",
              "PyQt6.QtPdf", "PyQt6.QtDesigner", "PyQt6.QtSql", "PyQt6.QtTest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="FlashcardViewer",
    icon=str(ICON) if sys.platform == "win32" else None,
    console=False,
    version=str(ROOT / "packaging" / "windows" / "version_info.txt") if sys.platform == "win32" else None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="FlashcardViewer")
