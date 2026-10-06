import base64
import sys
from pathlib import Path

import pytest

from flashcard_viewer import signing, updater


@pytest.fixture(autouse=True)
def no_release_key(monkeypatch):
    """Tests start without a release key; the signature tests set one explicitly."""
    monkeypatch.setattr(signing, "RELEASE_PUBLIC_KEY", "")

RELEASE = {
    "tag_name": "v1.3.0",
    "html_url": "https://github.com/Naved124/Riffle/releases/tag/v1.3.0",
    "body": "**Windows:** run the installer",
    "assets": [
        {"name": "Riffle-1.3.0.apk", "size": 10,
         "browser_download_url": "https://github.com/Naved124/Riffle/releases/download/v1.3.0/Riffle-1.3.0.apk"},
        {"name": "Riffle-Setup-1.3.0.exe", "size": 20, "digest": "sha256:" + "ab" * 32,
         "browser_download_url": "https://github.com/Naved124/Riffle/releases/download/v1.3.0/Riffle-Setup-1.3.0.exe"},
    ],
}


def test_version_comparison():
    assert updater.is_newer("1.2.0", "1.1.9")
    assert updater.is_newer("v1.10.0", "1.9.9")
    assert updater.is_newer("1.2", "1.1.5")
    assert not updater.is_newer("1.2.0", "1.2")
    assert not updater.is_newer("1.1.2", "1.1.2")
    assert not updater.is_newer("garbage", "1.0.0")
    assert updater.parse_version("v2.0.1-beta") == (2, 0, 1)


def test_windows_build_picks_the_installer_with_its_checksum():
    info = updater.summarize(RELEASE, "1.1.2", "installer")
    assert info["newer"] and info["canInstall"] and info["latest"] == "1.3.0"
    assert info["asset"]["name"] == "Riffle-Setup-1.3.0.exe"
    assert info["asset"]["sha256"] == "ab" * 32


def test_pip_install_needs_no_asset_and_source_checkout_cannot_install():
    assert updater.summarize(RELEASE, "1.1.2", "pip")["canInstall"]
    none = updater.summarize(RELEASE, "1.1.2", "none")
    assert none["newer"] and not none["canInstall"] and none["asset"] is None


def test_assets_from_other_hosts_are_ignored():
    rel = dict(RELEASE, assets=[dict(RELEASE["assets"][1], browser_download_url="https://evil.example/Riffle-Setup-1.3.0.exe")])
    assert updater.summarize(rel, "1.1.2", "installer")["canInstall"] is False


def test_download_refuses_unexpected_urls(tmp_path):
    import pytest
    with pytest.raises(ValueError):
        updater.download({"url": "https://evil.example/x.exe", "name": "x.exe"})


def test_running_from_a_checkout_is_not_self_updating():
    assert updater.install_method() == "none"


def test_relaunch_waits_for_this_process_to_exit():
    cmd = updater.relaunch_command([])
    if sys.platform != "win32":
        assert cmd[:3] == ["/bin/sh", "-c", 'sleep 1; exec "$@"']
    assert cmd[-2:] == ["-m", "flashcard_viewer"]


# ---- release signatures ----------------------------------------------------------------
import hashlib  # noqa: E402

from flashcard_viewer import ed25519  # noqa: E402

# RFC 8032, section 7.1, TEST 2
RFC_PK = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
RFC_SIG = bytes.fromhex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
                        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00")


def test_ed25519_rfc_vector_and_tampering():
    assert ed25519.verify(RFC_PK, b"\x72", RFC_SIG)
    assert not ed25519.verify(RFC_PK, b"\x73", RFC_SIG)
    bad = bytearray(RFC_SIG)
    bad[40] ^= 1
    assert not ed25519.verify(RFC_PK, b"\x72", bytes(bad))
    assert not ed25519.verify(RFC_PK[:31], b"\x72", RFC_SIG)


def test_ed25519_matches_openssl(tmp_path):
    import shutil
    import subprocess
    if not shutil.which("openssl"):
        pytest.skip("openssl not installed")
    key, msg, sig, pub = (tmp_path / n for n in ("k.pem", "m", "m.sig", "pub.der"))
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", key], check=True)
    msg.write_bytes(b"a3f0  Riffle-Setup-9.9.9.exe\n" * 50)
    subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", key, "-rawin", "-in", msg, "-out", sig], check=True)
    subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-outform", "DER", "-out", pub], check=True)
    assert ed25519.verify(pub.read_bytes()[-32:], msg.read_bytes(), sig.read_bytes())


SUMS_TEXT = ("ab" * 32 + "  Riffle-Setup-1.3.0.exe\n" + "cd" * 32 + " *flashcard_viewer-1.3.0-py3-none-any.whl\n")
SIGNED = dict(RELEASE, assets=RELEASE["assets"] + [
    {"name": n, "size": 1, "browser_download_url": updater.DOWNLOAD_PREFIX + "v1.3.0/" + n}
    for n in ("SHA256SUMS", "SHA256SUMS.sig", "flashcard_viewer-1.3.0-py3-none-any.whl")])


def test_parse_sums():
    sums = updater.parse_sums(SUMS_TEXT)
    assert sums["Riffle-Setup-1.3.0.exe"] == "ab" * 32
    assert sums["flashcard_viewer-1.3.0-py3-none-any.whl"] == "cd" * 32


def test_unsigned_releases_are_refused_once_a_key_is_set(monkeypatch):
    monkeypatch.setattr(updater.signing, "RELEASE_PUBLIC_KEY", RFC_PK.hex())
    assert updater.summarize(RELEASE, "1.1.2", "installer")["canInstall"] is False
    assert updater.summarize(RELEASE, "1.1.2", "pip")["canInstall"] is False  # no tarball fallback either
    info = updater.summarize(SIGNED, "1.1.2", "pip")
    assert info["canInstall"] and info["signed"] and info["asset"]["name"].endswith(".whl")


def _fake_fetch(files):
    def fetch(url, limit=1 << 20, timeout=15):
        return files[url.rsplit("/", 1)[1]]
    return fetch


def test_verified_checksum(monkeypatch, tmp_path):
    import shutil
    import subprocess
    if not shutil.which("openssl"):
        pytest.skip("openssl not installed")
    key, msg, sig, pub = (tmp_path / n for n in ("k.pem", "SHA256SUMS", "SHA256SUMS.sig", "pub.der"))
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", key], check=True)
    msg.write_text(SUMS_TEXT)
    subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", key, "-rawin", "-in", msg, "-out", sig], check=True)
    subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-outform", "DER", "-out", pub], check=True)
    pk = pub.read_bytes()[-32:].hex()
    info = updater.summarize(SIGNED, "1.1.2", "installer")

    monkeypatch.setattr(updater, "_fetch_small", _fake_fetch({"SHA256SUMS": msg.read_bytes(), "SHA256SUMS.sig": sig.read_bytes()}))
    assert updater.verified_checksum(info, "Riffle-Setup-1.3.0.exe", pk) == "ab" * 32
    with pytest.raises(updater.UpdateError):
        updater.verified_checksum(info, "something-else.exe", pk)
    with pytest.raises(updater.UpdateError):  # signed by a different key
        updater.verified_checksum(info, "Riffle-Setup-1.3.0.exe", RFC_PK.hex())

    forged = msg.read_bytes().replace(b"ab" * 32, b"ef" * 32)
    monkeypatch.setattr(updater, "_fetch_small", _fake_fetch({"SHA256SUMS": forged, "SHA256SUMS.sig": sig.read_bytes()}))
    with pytest.raises(updater.UpdateError):
        updater.verified_checksum(info, "Riffle-Setup-1.3.0.exe", pk)


def test_download_checks_the_signed_checksum(monkeypatch, tmp_path):
    import io
    body = b"installer bytes"

    class Resp(io.BytesIO):
        headers = {"Content-Length": str(len(body))}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(updater, "_open", lambda url, timeout: Resp(body))
    monkeypatch.setattr(updater.tempfile, "gettempdir", lambda: str(tmp_path))
    asset = {"name": "x.exe", "url": updater.DOWNLOAD_PREFIX + "v1/x.exe", "size": len(body)}
    good = updater.download(dict(asset, sha256=hashlib.sha256(body).hexdigest()))
    assert good.read_bytes() == body
    with pytest.raises(OSError):
        updater.download(dict(asset, sha256="00" * 32))


def test_committed_release_key_matches_its_pem():
    text = (Path(updater.__file__).parent / "signing.py").read_text()
    committed = text.split('RELEASE_PUBLIC_KEY = "', 1)[1].split('"', 1)[0]
    pem = Path(__file__).resolve().parent.parent / "packaging" / "release-signing-key.pem"
    if not committed:
        assert not pem.exists()
        return
    assert len(bytes.fromhex(committed)) == 32
    der = base64.b64decode("".join(line for line in pem.read_text().splitlines() if not line.startswith("-----")))
    assert der[-32:].hex() == committed
