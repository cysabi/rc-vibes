#!/usr/bin/env bash
# Run the local arclamp built by build.sh against the state from setup.sh.
#
#   dev/arclamp/run.sh          simulation only (-dry-run): full API and live
#                               stream, no radio. Use this day to day.
#   dev/arclamp/run.sh --radio  drive a base station plugged into this Mac.
#                               Every bulb in range on the configured channel
#                               will follow this copy.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="$root/.arclamp/bin"
state="$root/.arclamp/state"
port="${ARCLAMP_PORT:-8080}"

if [ ! -s "$state/token.key" ]; then
	echo "no local arclamp state; run dev/arclamp/setup.sh first" >&2
	exit 1
fi

args=(
	-addr "127.0.0.1:$port"
	-config "$state/lights.json"
	-tokens "$state/service_tokens.json"
	-token-key "$state/token.key"
	-prelude "$state/prelude.js"
	-prelude-url "$state/prelude-url.js"
	-sandbox "$bin/sandbox"
	-audit "$state/audit.log"
)

if [ "${1:-}" = "--radio" ]; then
	echo "arclamp on 127.0.0.1:$port driving the radio (channel from $state/radios.json)"
	exec "$bin/arclamp" "${args[@]}" -radios "$state/radios.json"
fi

# Dry-run also dumps every 100 Hz frame to stdout; keep only the log lines.
echo "arclamp on 127.0.0.1:$port (dry run, no radio)"
"$bin/arclamp" "${args[@]}" -dry-run | grep --line-buffered '"level"'
