#!/usr/bin/env bash
# Build arclamp and its V8 sandbox from a local rclamp checkout into
# .arclamp/bin. Uses rclamp's own nix dev shell for the Go toolchain, so
# nothing is installed system-wide and the rclamp checkout is left untouched.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
src="${ARCLAMP_SRC:-$HOME/Documents/JCLemme/rclamp}"
out="$root/.arclamp/bin"
mkdir -p "$out"
cd "$src/backend"
echo "building arclamp from $src ($(git -C "$src" rev-parse --short HEAD))"
nix develop "$src" -c sh -c "go build -o '$out/arclamp' ./cmd/arclamp && go build -o '$out/sandbox' ./cmd/sandbox"
echo "built: $out/arclamp $out/sandbox"
