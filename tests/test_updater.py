import sys

from flashcard_viewer import updater

RELEASE = {
    "tag_name": "v1.3.0",
    "html_url": "https://github.com/Naved124/flashcard-viewer/releases/tag/v1.3.0",
    "body": "**Windows:** run the installer",
    "assets": [
        {"name": "FlashcardViewer-1.3.0.apk", "size": 10,
         "browser_download_url": "https://github.com/Naved124/flashcard-viewer/releases/download/v1.3.0/FlashcardViewer-1.3.0.apk"},
        {"name": "FlashcardViewer-Setup-1.3.0.exe", "size": 20, "digest": "sha256:" + "ab" * 32,
         "browser_download_url": "https://github.com/Naved124/flashcard-viewer/releases/download/v1.3.0/FlashcardViewer-Setup-1.3.0.exe"},
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
    assert info["asset"]["name"] == "FlashcardViewer-Setup-1.3.0.exe"
    assert info["asset"]["sha256"] == "ab" * 32


def test_pip_install_needs_no_asset_and_source_checkout_cannot_install():
    assert updater.summarize(RELEASE, "1.1.2", "pip")["canInstall"]
    none = updater.summarize(RELEASE, "1.1.2", "none")
    assert none["newer"] and not none["canInstall"] and none["asset"] is None


def test_assets_from_other_hosts_are_ignored():
    rel = dict(RELEASE, assets=[dict(RELEASE["assets"][1], browser_download_url="https://evil.example/FlashcardViewer-Setup-1.3.0.exe")])
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
