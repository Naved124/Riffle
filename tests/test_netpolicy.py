import io
import zipfile

import pytest

from flashcard_viewer.netpolicy import is_public_host, sibling_allowed


@pytest.mark.parametrize("host", ["cdn.jsdelivr.net", "fonts.googleapis.com", "face.de", "dead.beef", "8.8.8.8",
                                  "[2606:4700::1111]", "unpkg.com."])
def test_public_hosts(host):
    assert is_public_host(host)


@pytest.mark.parametrize("host", ["localhost", "LOCALHOST", "foo.localhost", "127.0.0.1", "127.1", "2130706433",
                                  "0x7f.1", "0177.0.0.1", "0.0.0.0", "10.0.0.5", "172.16.3.4", "192.168.1.1",
                                  "100.64.1.1", "169.254.169.254", "[::1]", "::ffff:192.168.0.1", "fe80::1", "fd00::5",
                                  "router", "nas.local", "printer.lan", "box.home.arpa", "", "256.1.1.1"])
def test_local_and_private_hosts_are_refused(host):
    assert not is_public_host(host)


@pytest.mark.parametrize("path", ["img/a.png", "/style.css", "fonts/x.WOFF2", "audio/a.mp3", "app.js"])
def test_web_assets_next_to_a_deck_are_served(path):
    assert sibling_allowed(path)


@pytest.mark.parametrize("path", [".ssh/id_rsa", "passwords.txt", "notes/.hidden.png", ".env", "cards.json",
                                  "other.html", "a/../b.png", "..\\x.png", "id_rsa", "", "/"])
def test_documents_secrets_and_hidden_files_are_not(path):
    assert not sibling_allowed(path)


def _zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)
    buf.seek(0)
    return zipfile.ZipFile(buf)


def test_backup_restores_only_known_files():
    from flashcard_viewer.backup import backup_entries
    z = _zip({"settings.json": "{}", "stats.json": "{}", "overrides/abc123.json": "{}",
              "overrides/..\\..\\evil.json": "{}", "overrides/../../evil.json": "{}", "overrides/sub/x.json": "{}",
              "../settings.json": "{}", "evil.sh": "rm -rf ~"})
    assert set(backup_entries(z)) == {"settings.json", "stats.json", "overrides/abc123.json"}


def test_backup_size_limit(monkeypatch):
    from flashcard_viewer import backup
    monkeypatch.setattr(backup, "BACKUP_MAX_BYTES", 10)
    with pytest.raises(ValueError):
        backup.backup_entries(_zip({"stats.json": "x" * 11}))


def test_names_pointing_at_private_addresses_are_refused(monkeypatch):
    from flashcard_viewer import netpolicy

    answers = {"rebind.example.com": "127.0.0.1", "lan.example.com": "192.168.1.20", "cdn.example.com": "93.184.216.34"}

    def fake_getaddrinfo(host, port):
        if host not in answers:
            raise OSError("no such host")
        return [(2, 1, 6, "", (answers[host], 0))]

    monkeypatch.setattr(netpolicy.socket, "getaddrinfo", fake_getaddrinfo)
    netpolicy._dns_cache.clear()
    assert not netpolicy.reaches_public_network("rebind.example.com")
    assert not netpolicy.reaches_public_network("lan.example.com")
    assert netpolicy.reaches_public_network("cdn.example.com")
    assert netpolicy.reaches_public_network("8.8.8.8")
    for host in ("localhost", "127.0.0.1", "10.1.2.3", "[::1]", "router", "nas.local"):
        assert not netpolicy.reaches_public_network(host)
    netpolicy._dns_cache.clear()
