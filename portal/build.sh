#!/usr/bin/env bash
# Builds vibes-portal.apk: vibes full screen, for the Facebook Portal (Android 9).
# No Gradle: aapt2, javac, d8 and apksigner from nixpkgs' Android SDK.
#   portal/build.sh             -> portal/build/vibes-portal.apk
# Signed with ~/.android/vibes-portal.p12 (made on first build). Keep it:
# an update must be signed with the same key, or the Portal won't install it.
set -euo pipefail
cd "$(dirname "$0")"

tool() { nix build --impure --no-link --print-out-paths -f tools.nix "$1"; }
SDK=$(tool sdk)/libexec/android-sdk
JDK=$(tool jdk)
BT=$SDK/build-tools/34.0.0
JAR=$SDK/platforms/android-34/android.jar
export JAVA_HOME=$JDK PATH=$JDK/bin:$PATH

KS=${VIBES_PORTAL_KEYSTORE:-$HOME/.android/vibes-portal.p12}
if [[ ! -f $KS ]]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass vibes-portal -alias vibes \
    -keyalg EC -groupname secp256r1 -validity 36500 -dname "CN=vibes portal" >/dev/null
fi

rm -rf build && mkdir -p build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o build/unaligned.apk build/res.zip \
  --java build/gen --min-sdk-version 28 --target-sdk-version 34 \
  --version-code "$(date -u +%y%m%d%H)" --version-name "$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR:$BT/core-lambda-stubs.jar" -d build/classes \
  $(find src build/gen -name '*.java')
"$BT/d8" --release --min-api 28 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../unaligned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unaligned.apk build/aligned.apk
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:vibes-portal --out build/vibes-portal.apk build/aligned.apk
echo "$(pwd)/build/vibes-portal.apk"
