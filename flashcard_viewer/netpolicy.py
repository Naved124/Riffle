"""What untrusted deck pages may reach.

Decks are arbitrary HTML/JavaScript from anywhere, so the app limits:

* which files next to a deck it serves (``sibling_allowed``): only ordinary web assets, never hidden
  files or folders, so a deck can't read documents, keys or configs that happen to sit beside it;
* which hosts a deck may send requests to, directly or through the offline CDN cache
  (``reaches_public_network``): never this machine or the local network, so a deck can't read or
  poke a router page or a local service. Host names are resolved, so a public-looking name that
  points at a private address is refused too.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
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


# -- host names: resolve them and check every address --------------------------------------------
_DNS_TTL = 300.0
_dns_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="netpolicy-dns")
_dns_lock = threading.Lock()
_dns_cache: dict[str, tuple[float, bool]] = {}
_dns_pending: dict[str, Future] = {}


def _resolves_public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True  # unresolvable: the request fails anyway
    return bool(infos) and all(is_public_host(info[4][0].split("%")[0]) for info in infos)


def _remember(host: str, fut: Future) -> None:
    try:
        ok = fut.result()
    except Exception:  # noqa: BLE001
        ok = False
    with _dns_lock:
        _dns_cache[host] = (time.monotonic(), ok)
        _dns_pending.pop(host, None)


def reaches_public_network(host: str, timeout: float = 0.5) -> bool:
    """True when every address ``host`` stands for is public. Names are resolved (cached for a few
    minutes); one that doesn't resolve within ``timeout`` counts as not public for now."""
    if not is_public_host(host):
        return False
    h = (host or "").strip().lower().rstrip(".").strip("[]")
    try:
        ipaddress.ip_address(h)
        return True  # a public address literal
    except ValueError:
        pass
    now = time.monotonic()
    started = False
    with _dns_lock:
        hit = _dns_cache.get(h)
        if hit and now - hit[0] < _DNS_TTL:
            return hit[1]
        fut = _dns_pending.get(h)
        if fut is None:
            fut = _dns_pool.submit(_resolves_public, h)
            _dns_pending[h] = fut
            started = True
    if started:
        # Outside the lock: for a lookup that has already finished, the callback runs right here.
        fut.add_done_callback(lambda f, h=h: _remember(h, f))
    try:
        return bool(fut.result(timeout=timeout))
    except FutureTimeout:
        return False
