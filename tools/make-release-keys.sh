#!/usr/bin/env bash
# Create the two private keys that sign Riffle releases, and print the GitHub secrets
# CI needs. Run it once, from the repository root:
#
#   tools/make-release-keys.sh
#
#  1. Android signing key   ~/flashcard-viewer-keys/android-release.p12
#     Signs the APK. Phones only accept an update signed with the same key as the installed app.
#  2. Release signing key   ~/flashcard-viewer-keys/release-signing-key.pem   (Ed25519)
#     Signs SHA256SUMS of every release (Windows installer, Linux wheel, APK). The Windows and Linux
#     apps only install updates carrying a valid signature from this key. Its public half is written
#     into flashcard_viewer/signing.py and packaging/release-signing-key.pem, which you commit.
#
# Back up the keys folder (password manager, USB stick). Without these keys you can't publish
# updates that installed apps will accept. Never commit the private keys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS="${KEYS_DIR:-$HOME/flashcard-viewer-keys}"
ANDROID_KEY="$KEYS/android-release.p12"
RELEASE_KEY="$KEYS/release-signing-key.pem"
ALIAS="flashcard-viewer"
mkdir -p "$KEYS"
chmod 700 "$KEYS"
command -v openssl >/dev/null || { echo "openssl is required." >&2; exit 1; }

# An Android key made by the older make-android-key.sh is reused, not replaced.
[[ -e "$ANDROID_KEY" || ! -e "$HOME/flashcard-viewer-release.p12" ]] || mv "$HOME/flashcard-viewer-release.p12" "$ANDROID_KEY"

declare -A SECRETS=()

# ---- 1. Android key ---------------------------------------------------------------------------
if [[ -e "$ANDROID_KEY" ]]; then
  echo "Android key: using existing $ANDROID_KEY"
  echo "  (its ANDROID_* secrets should already be on GitHub; re-add them if not)"
  NEW_ANDROID=0
else
  read -rsp "Choose a password for the Android key (8+ characters): " PASS; echo
  read -rsp "Repeat it: " PASS2; echo
  [[ "$PASS" == "$PASS2" ]] || { echo "Passwords don't match." >&2; exit 1; }
  (( ${#PASS} >= 8 )) || { echo "Use at least 8 characters." >&2; exit 1; }
  if command -v keytool >/dev/null; then
    keytool -genkeypair -storetype PKCS12 -keystore "$ANDROID_KEY" -alias "$ALIAS" -keyalg RSA -keysize 4096 \
      -validity 10000 -dname "CN=Riffle" -storepass "$PASS" -keypass "$PASS" >/dev/null 2>&1
  else
    tmp=$(mktemp -d)
    openssl req -x509 -newkey rsa:4096 -sha256 -days 10000 -nodes -subj "/CN=Riffle" \
      -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
    openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$ALIAS" -out "$ANDROID_KEY" -passout "pass:$PASS"
    rm -rf "$tmp"
  fi
  chmod 600 "$ANDROID_KEY"
  echo "Android key: created $ANDROID_KEY"
  SECRETS[ANDROID_KEYSTORE_BASE64]=$(base64 -w0 "$ANDROID_KEY" 2>/dev/null || base64 < "$ANDROID_KEY" | tr -d '\n')
  SECRETS[ANDROID_KEYSTORE_PASSWORD]=$PASS
  SECRETS[ANDROID_KEY_ALIAS]=$ALIAS
  SECRETS[ANDROID_KEY_PASSWORD]=$PASS
  NEW_ANDROID=1
fi

# ---- 2. Release (Ed25519) key -------------------------------------------------------------------
if [[ -e "$RELEASE_KEY" ]]; then
  echo "Release key: using existing $RELEASE_KEY"
else
  openssl genpkey -algorithm ed25519 -out "$RELEASE_KEY"
  chmod 600 "$RELEASE_KEY"
  echo "Release key: created $RELEASE_KEY"
fi
SECRETS[RELEASE_SIGNING_KEY]=$(cat "$RELEASE_KEY")
PUB_HEX=$(openssl pkey -in "$RELEASE_KEY" -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \n')
openssl pkey -in "$RELEASE_KEY" -pubout -out "$ROOT/packaging/release-signing-key.pem"
sed -i.bak "s/^RELEASE_PUBLIC_KEY = .*/RELEASE_PUBLIC_KEY = \"$PUB_HEX\"/" "$ROOT/flashcard_viewer/signing.py"
rm -f "$ROOT/flashcard_viewer/signing.py.bak"
echo "Public key written to flashcard_viewer/signing.py and packaging/release-signing-key.pem"
echo

# ---- secrets ------------------------------------------------------------------------------------
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  read -rp "Upload the secrets to GitHub now with the gh CLI? [y/N] " yn
  if [[ "$yn" =~ ^[Yy] ]]; then
    for name in "${!SECRETS[@]}"; do printf '%s' "${SECRETS[$name]}" | gh secret set "$name"; done
    echo "Secrets uploaded: ${!SECRETS[*]}"
    echo
    echo "Now commit and push the public key:"
    echo "  git add flashcard_viewer/signing.py packaging/release-signing-key.pem && git commit -m 'Add release signing key' && git push"
    exit 0
  fi
fi

OUT="$KEYS/github-secrets.txt"
{
  echo "Add each of these at GitHub -> your repo -> Settings -> Secrets and variables -> Actions -> New repository secret."
  echo "The value is everything between the lines. Delete this file afterwards."
  for name in "${!SECRETS[@]}"; do
    printf '\n=== %s ===\n%s\n=== end ===\n' "$name" "${SECRETS[$name]}"
  done
} > "$OUT"
chmod 600 "$OUT"
cat <<MSG
Next:
  1. Add the secrets listed in $OUT
     ($( (( NEW_ANDROID )) && echo "ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD and " )RELEASE_SIGNING_KEY),
     then delete that file.
  2. Commit and push the public key (only after step 1, or the release build fails):
       git add flashcard_viewer/signing.py packaging/release-signing-key.pem
       git commit -m "Add release signing key" && git push
MSG
