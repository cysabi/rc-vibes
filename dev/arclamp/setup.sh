#!/usr/bin/env bash
# One-time state for a local arclamp: production's light list and prelude
# copied from rclamp, a radio config that finds the base station on a Mac, a
# fresh token signing key, and a "vibes" service token written to .env.
# Safe to re-run: config files are refreshed, the key and token are kept.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
src="${ARCLAMP_SRC:-$HOME/Documents/JCLemme/rclamp}"
bin="$root/.arclamp/bin"
state="$root/.arclamp/state"
mkdir -p "$state"

if [ ! -x "$bin/arclamp" ]; then
	echo "no arclamp binary; run dev/arclamp/build.sh first" >&2
	exit 1
fi

cp "$src/deploy/lights.json" "$state/lights.json"
cp "$src/deploy/prelude.js" "$state/prelude.js"
cp "$src/backend/config/dev/prelude-url.js" "$state/prelude-url.js"

# Production's stations and channel, but the base station enumerates as
# /dev/cu.usbmodem* on macOS rather than the Pi's /dev/ttyACM*.
node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
cfg.globs = ["/dev/cu.usbmodem*"];
process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
' "$src/deploy/radios.json" >"$state/radios.json"

[ -s "$state/token.key" ] || openssl rand -hex 32 >"$state/token.key"

if [ ! -s "$state/vibes.token" ]; then
	"$bin/arclamp" token mint -tokens "$state/service_tokens.json" -token-key "$state/token.key" \
		-perms control,mint vibes | grep '^arclamp-' >"$state/vibes.token"
	echo "minted local vibes token"
fi

if [ ! -f "$root/.env" ]; then
	{
		echo "ARCLAMP_BASE_URL=http://127.0.0.1:${ARCLAMP_PORT:-8080}"
		echo "ARCLAMP_KEY=$(cat "$state/vibes.token")"
		echo "SESSION_SECRET=$(openssl rand -hex 32)"
		echo "VIBES_DEV_LOGIN=1"
	} >"$root/.env"
	echo "wrote .env"
fi
echo "local arclamp state ready in $state"
