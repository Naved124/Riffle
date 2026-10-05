"""What untrusted deck pages may reach.

Decks are arbitrary HTML/JavaScript from anywhere, so the app limits:

* which files next to a deck it serves (``sibling_allowed``): only ordinary web assets, never hidden
  files or folders, so a deck can't read documents, keys or configs that happen to sit beside it;
* which hosts the offline CDN cache fetches for a deck (``is_public_host``): never this machine or
  the local network, so a deck can't use the app to read a router page or a local service.
"""

from __future__ import annotations

import ipaddress
import re
from pathlib import PurePosixPath

# Images, styles, scripts, fonts and media a deck may load from its own folder.
SIBLING_EXTS = frozenset("""
    png jpg jpeg gif webp avif svg ico bmp
    css js mjs
    woff woff2 ttf otf
    mp3 wav ogg oga m4a aac flac mp4 webm ogv
""".split())

_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp")


def sibling_allowed(rel_path: str) -> bool:
    """May a deck load ``rel_path`` (relative to its own folder)?"""
    rel = rel_path.replace("\\", "/").lstrip("/")
    parts = PurePosixPath(rel).parts
    if not parts or any(p.startswith(".") for p in parts):
        return False
    name = parts[-1]
    return "." in name and name.rsplit(".", 1)[1].lower() in SIBLING_EXTS


def is_public_host(host: str) -> bool:
    """False for loopback, private, link-local and other non-public addresses and names."""
    h = (host or "").strip().lower().rstrip(".").strip("[]")
    if not h or h == "localhost" or h.endswith(_LOCAL_SUFFIXES):
        return False
    if "." not in h and ":" not in h:
        return False  # single-label intranet names ("router", "nas")
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        # Other numeric IPv4 spellings browsers accept ("2130706433", "0x7f.1", "127.1", "0177.0.0.1").
        parts = h.split(".")
        if len(parts) <= 4 and all(re.fullmatch(r"0x[0-9a-f]*|\d+", p) for p in parts):
            return False
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast
