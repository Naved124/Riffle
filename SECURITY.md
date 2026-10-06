# Security

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security → Report a vulnerability** on this repository (a private advisory). Don't open a public
issue for them. Include the version, the platform and, ideally, a deck file that shows the problem.

## How releases are protected

- **Windows and Linux.** Every release has `SHA256SUMS` and `SHA256SUMS.sig`, an Ed25519 signature
  made with the project's private release key. The apps only install an update whose signature
  matches the public key in `flashcard_viewer/signing.py` (also in
  `packaging/release-signing-key.pem`). To check a download by hand, put `SHA256SUMS` and
  `SHA256SUMS.sig` next to it and run:

  ```bash
  openssl pkeyutl -verify -pubin -inkey packaging/release-signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
  sha256sum --check --ignore-missing SHA256SUMS
  ```

- **Android.** Release APKs are signed with a private key kept in the repository's secrets. Android
  only installs an update signed with the same key as the installed app.

## Decks are untrusted

Flashcard decks are HTML and JavaScript from anywhere, so the apps treat them as untrusted:

- A deck runs in its own origin (desktop) or a sandboxed frame (Android). It can't reach the app's
  backend or its stored data, or read other decks.
- A deck can load only ordinary web assets (images, styles, scripts, fonts, media) from its own folder,
  never hidden files. A deck opened from outside your deck library (for example with "Open with" from
  Downloads) can load none.
- The offline CDN cache never fetches from this device or the local network, and lets a deck read a
  response only when the original server allows cross-origin reads.
- Decks made with the deck editor are no exception. Their cards are shown as text (the Markdown renderer
  escapes everything; links can only be `http(s):` or `mailto:`, images only ones embedded in the deck or
  `https:` URLs), the editor's live preview runs in a sandboxed frame, and the app only overwrites a deck
  file that the deck editor made, with another such deck.

## Retired key: do not trust

Versions up to 1.1.2 were signed with a public test key ("sideload") that was committed to this
repository and is still in its history. It is **retired**: anyone could sign an APK with it.

| | |
|---|---|
| Owner | `CN=Flashcard Viewer sideload key, O=Naved124` |
| SHA-256 | `DA:04:99:77:40:FD:F0:CC:36:36:52:7F:54:43:6A:D7:0E:54:B2:3C:AD:6A:25:5A:F8:1C:CB:70:06:44:26:5C` |

If your Android app is version 1.1.2 or older, export a backup (Settings → Backup & reset), uninstall
it, install the latest APK from the Releases page and restore the backup. Never install an APK signed
with the key above.
