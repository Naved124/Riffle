#!/usr/bin/env bash
# Create the private key that signs the Android app, and print the four GitHub secrets CI needs.
#
#   tools/make-android-key.sh            # writes ~/flashcard-viewer-release.p12
#
# Keep the .p12 file and the password somewhere safe (a password manager, an offline backup).
# Every future update must be signed with this same key: if it is lost, installed apps can't be
# updated any more and everyone has to uninstall and reinstall.
set -euo pipefail

OUT="${1:-$HOME/flashcard-viewer-release.p12}"
ALIAS="flashcard-viewer"

if [[ -e "$OUT" ]]; then
  echo "$OUT already exists. Refusing to overwrite your key." >&2
  exit 1
fi

read -rsp "Choose a password for the key (8+ characters): " PASS; echo
read -rsp "Repeat it: " PASS2; echo
[[ "$PASS" == "$PASS2" ]] || { echo "Passwords don't match." >&2; exit 1; }
(( ${#PASS} >= 8 )) || { echo "Use at least 8 characters." >&2; exit 1; }

if command -v keytool >/dev/null; then
  keytool -genkeypair -storetype PKCS12 -keystore "$OUT" -alias "$ALIAS" -keyalg RSA -keysize 4096 \
    -validity 10000 -dname "CN=Flashcard Viewer" -storepass "$PASS" -keypass "$PASS" >/dev/null
elif command -v openssl >/dev/null; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  openssl req -x509 -newkey rsa:4096 -sha256 -days 10000 -nodes -subj "/CN=Flashcard Viewer" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$ALIAS" \
    -out "$OUT" -passout "pass:$PASS"
else
  echo "Needs either keytool (any Java JDK) or openssl." >&2
  exit 1
fi
chmod 600 "$OUT"
echo "Created $OUT"
echo

B64=$(base64 -w0 "$OUT" 2>/dev/null || base64 < "$OUT" | tr -d '\n')
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  read -rp "Upload the secrets to GitHub now with the gh CLI? [y/N] " yn
  if [[ "$yn" =~ ^[Yy] ]]; then
    printf '%s' "$B64" | gh secret set ANDROID_KEYSTORE_BASE64
    printf '%s' "$PASS" | gh secret set ANDROID_KEYSTORE_PASSWORD
    printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS
    printf '%s' "$PASS" | gh secret set ANDROID_KEY_PASSWORD
    echo "Done. Re-run the latest \"Build apps\" workflow to publish a signed APK."
    exit 0
  fi
fi

printf '%s' "$B64" > "$OUT.base64"
chmod 600 "$OUT.base64"
cat <<MSG
Add these at GitHub → your repo → Settings → Secrets and variables → Actions → New repository secret:

  ANDROID_KEYSTORE_BASE64   the contents of: $OUT.base64 (written next to the key)
  ANDROID_KEYSTORE_PASSWORD the password you just chose
  ANDROID_KEY_ALIAS         $ALIAS
  ANDROID_KEY_PASSWORD      the same password

Then re-run the latest "Build apps" workflow to publish a signed APK.
Delete $OUT.base64 once the secret is saved.
MSG
