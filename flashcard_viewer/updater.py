"""Update checks against the project's GitHub Releases, and installing them in place.

* Windows (frozen PyInstaller build): download the new ``FlashcardViewer-Setup-<v>.exe`` and run it
  silently; Inno Setup keeps the previous install location and relaunches the app.
* Linux (``install.sh`` virtual environment): ``pip install --upgrade`` the release's wheel into the
  running interpreter, then restart.

Every release carries SHA256SUMS and SHA256SUMS.sig, an Ed25519 signature made with the project's
private release key. Once the public key is set in ``signing.py``, an update is only installed when
that signature is valid and the downloaded file matches its signed checksum.
* Anything else (running from a source checkout): report the update and link to the release page.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from . import ed25519, signing

REPO = "Naved124/flashcard-viewer"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
DOWNLOAD_PREFIX = f"https://github.com/{REPO}/releases/download/"
USER_AGENT = "flashcard-viewer-updater"
SUMS = "SHA256SUMS"
WHEEL_RX = re.compile(r"flashcard_viewer-[\w.]+-py3-none-any\.whl")
INSTALLER_RX = re.compile(r"FlashcardViewer-Setup-[\w.\-]+\.exe")


class UpdateError(Exception):
    pass


def signatures_required() -> bool:
    return bool(signing.RELEASE_PUBLIC_KEY)


def parse_version(v: str) -> tuple[int, ...]:
    """'v1.2.10' -> (1, 2, 10). Unknown parts count as 0, so garbage never looks newer."""
    nums = re.findall(r"\d+", (v or "").split("-")[0].split("+")[0])
    return tuple(int(n) for n in nums[:4]) or (0,)


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def install_method() -> str:
    """'installer' (Windows build), 'pip' (Linux install.sh venv) or 'none'."""
    if getattr(sys, "frozen", False):
        return "installer" if sys.platform == "win32" else "none"
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    here = Path(__file__).resolve()
    installed = any(part in ("site-packages", "dist-packages") for part in here.parts)
    if in_venv and installed and sys.platform.startswith("linux"):
        return "pip"
    return "none"


def _find(release: dict, match) -> dict | None:
    for a in release.get("assets") or []:
        name = a.get("name", "")
        url = a.get("browser_download_url", "")
        if match(name) and url.startswith(DOWNLOAD_PREFIX):
            digest = a.get("digest") or ""
            return {"name": name, "url": url, "size": int(a.get("size") or 0),
                    "sha256": digest[7:] if digest.startswith("sha256:") else ""}
    return None


def pick_asset(release: dict, method: str) -> dict | None:
    if method == "installer":
        return _find(release, INSTALLER_RX.fullmatch)
    if method == "pip":
        return _find(release, WHEEL_RX.fullmatch)
    return None


def summarize(release: dict, current: str, method: str | None = None) -> dict:
    method = method or install_method()
    tag = release.get("tag_name") or ""
    latest = tag.lstrip("vV")
    asset = pick_asset(release, method)
    sums = _find(release, lambda n: n == SUMS)
    sig = _find(release, lambda n: n == SUMS + ".sig")
    signed = sums is not None and sig is not None
    if method == "installer":
        can_install = asset is not None
    elif method == "pip":
        # Older releases have no wheel; their source archive is only acceptable while signing isn't set up.
        can_install = asset is not None or (bool(tag) and not signatures_required())
    else:
        can_install = False
    if signatures_required() and not signed:
        can_install = False
    return {
        "state": "checked",
        "current": current,
        "latest": latest,
        "tag": tag,
        "newer": bool(latest) and is_newer(latest, current),
        "notes": (release.get("body") or "")[:4000],
        "page": release.get("html_url") or f"https://github.com/{REPO}/releases/latest",
        "asset": asset,
        "method": method,
        "canInstall": can_install,
        "signed": signed,
        "sums": sums["url"] if sums else "",
        "sig": sig["url"] if sig else "",
    }


def _open(url: str, timeout: float):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 - fixed https URLs only


def fetch_latest(timeout: float = 15) -> dict:
    with _open(API_LATEST, timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _fetch_small(url: str, limit: int = 1 << 20, timeout: float = 15) -> bytes:
    if not url.startswith(DOWNLOAD_PREFIX):
        raise UpdateError("refusing to download from an unexpected address")
    with _open(url, timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("file is unexpectedly large")
    return data


def parse_sums(text: str) -> dict[str, str]:
    """``sha256sum`` output -> {file name: hex digest}."""
    out = {}
    for line in text.splitlines():
        m = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+?)\s*", line)
        if m:
            out[m.group(2)] = m.group(1).lower()
    return out


def verified_checksum(info: dict, name: str, public_key_hex: str | None = None) -> str:
    """The SHA-256 of ``name`` from the release's SHA256SUMS, after checking its signature."""
    key = public_key_hex if public_key_hex is not None else signing.RELEASE_PUBLIC_KEY
    if not info.get("sums") or not info.get("sig"):
        raise UpdateError("this release isn't signed, so it won't be installed")
    data = _fetch_small(info["sums"])
    sig = _fetch_small(info["sig"], limit=1024)
    if not ed25519.verify(bytes.fromhex(key), data, sig):
        raise UpdateError("the release signature is not valid, so it won't be installed")
    digest = parse_sums(data.decode("utf-8", "replace")).get(name)
    if not digest:
        raise UpdateError(f"{name} is not listed in the signed checksums")
    return digest


def download(asset: dict, progress=lambda f: None, timeout: float = 30) -> Path:
    """Download a release asset to a temp file, checking size and SHA-256 when GitHub provides them."""
    url = asset["url"]
    if not url.startswith(DOWNLOAD_PREFIX):
        raise ValueError("refusing to download from an unexpected address")
    out = Path(tempfile.gettempdir()) / "flashcard-viewer-update" / asset["name"]
    out.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    done = 0
    with _open(url, timeout) as r, open(out, "wb") as f:
        total = int(r.headers.get("Content-Length") or asset.get("size") or 0)
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            done += len(chunk)
            progress(done / total if total else -1)
    if asset.get("size") and done != asset["size"]:
        raise OSError(f"download incomplete ({done} of {asset['size']} bytes)")
    if asset.get("sha256") and h.hexdigest().lower() != asset["sha256"].lower():
        out.unlink(missing_ok=True)
        raise OSError("downloaded file failed its checksum")
    return out


def run_windows_installer(path: Path) -> None:
    """Start the installer detached; it closes this app, updates it in place and relaunches it."""
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([str(path), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"],
                     creationflags=flags, close_fds=True)


def pip_upgrade(source: str) -> None:
    """Install a downloaded wheel (or, for releases without one, a tag's source archive)."""
    if not os.path.isfile(source):
        source = f"https://github.com/{REPO}/archive/refs/tags/{source}.tar.gz"
    proc = subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "--quiet",
                           "--disable-pip-version-check", source],
                          capture_output=True, text=True, timeout=900)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        raise OSError("pip failed: " + " ".join(tail))


def relaunch_command(argv: list[str]) -> list[str]:
    """Command that restarts the app a moment after this process exits (so the single-instance
    lock is free)."""
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, *argv]
    else:
        cmd = [sys.executable, "-m", "flashcard_viewer", *argv]
    if os.name == "posix":
        return ["/bin/sh", "-c", 'sleep 1; exec "$@"', "sh", *cmd]
    return cmd
