"""Which files the app restores from a backup zip (kept free of Qt so it can be tested anywhere)."""

from __future__ import annotations

import re
import zipfile

BACKUP_MAX_BYTES = 64 * 1024 * 1024
OVERRIDE_NAME = re.compile(r"overrides/([A-Za-z0-9_-]{1,64}\.json)")


def backup_entries(z: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    """The members of a backup zip the app restores, after checking names and sizes. Backups may come
    from someone else, so nothing outside the known file names is touched (no path tricks)."""
    out = {}
    total = 0
    for info in z.infolist():
        name = info.filename
        if name in ("settings.json", "library.json", "stats.json") or OVERRIDE_NAME.fullmatch(name):
            total += info.file_size
            if info.file_size > BACKUP_MAX_BYTES or total > BACKUP_MAX_BYTES:
                raise ValueError("backup is too large")
            out[name] = info
    return out
