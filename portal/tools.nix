# The Android SDK (build-tools 34, android-34) and a JDK, for build.sh.
# Building it accepts the Android SDK licence.
let
  pkgs = import (builtins.getFlake "github:NixOS/nixpkgs/nixpkgs-unstable") {
    system = builtins.currentSystem;
    config = { android_sdk.accept_license = true; allowUnfree = true; };
  };
in {
  sdk = (pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "34" ];
    buildToolsVersions = [ "34.0.0" ];
    includeEmulator = false;
    includeSystemImages = false;
    includeNDK = false;
  }).androidsdk;
  jdk = pkgs.jdk17_headless;
}
