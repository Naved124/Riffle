"""The project's release-signing public key (Ed25519, hex).

CI signs every release's SHA256SUMS with the matching private key (repository secret
RELEASE_SIGNING_KEY). When this is set, the app installs only updates whose checksums carry a valid
signature. tools/make-release-keys.sh fills it in; the same key is in packaging/release-signing-key.pem.
"""

RELEASE_PUBLIC_KEY = "e5693fc5451223b6fe7059d57950b7954c916b8fbf4f80de22e3ce539f395a90"
