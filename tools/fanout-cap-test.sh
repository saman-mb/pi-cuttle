#!/usr/bin/env bash
#
# Fanout cap test (#13, #23).
#
# Launches N concurrent pi processes that all route through cuttle/auto to the same
# local model, samples the filesystem slot directory while they run, and asserts the
# peak number of concurrent local slots never exceeds local.maxConcurrent.
#
# Async subagent children are separate pi processes too, so this exercises the same
# cross-process property the governor exists to guarantee.
#
# Requirements: pi on PATH, LM Studio reachable, an authenticated cloud provider.
#
# Note: `pi` also loads installed packages, so if pi-cuttle is installed as a package its
# `--cuttle-force` flag conflicts with `-e "$EXT"` and every process fails to load. The run
# then exercises nothing, which is why this script asserts that routing actually happened
# instead of trusting a peak of zero (#59).
#
# Usage:
#   tools/fanout-cap-test.sh          # N=4, cap=1
#   N=6 MAX=2 tools/fanout-cap-test.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="${EXT:-$HERE/../src/index.ts}"
N="${N:-4}"
CAP="${CAP:-1}"
LOCAL="${LOCAL:-lmstudio/prism-ml/bonsai-27b}"
CLOUD="${CLOUD:-opencode-go/deepseek-v4.1-flash}"
LMSTUDIO="${LMSTUDIO:-http://localhost:1235}"

if ! command -v pi >/dev/null 2>&1; then
	echo "SKIP: pi not on PATH"
	exit 0
fi
if ! curl -s --max-time 3 "$LMSTUDIO/api/v1/models" >/dev/null 2>&1; then
	echo "SKIP: LM Studio not reachable at $LMSTUDIO"
	exit 0
fi

DIR="$(mktemp -d "${TMPDIR:-/tmp}/pmr-fanout.XXXXXX")"
mkdir -p "$DIR/.pi" "$DIR/slots"
trap 'rm -rf "$DIR"' EXIT

cat >"$DIR/.pi/cuttle.json" <<EOF
{
  "autoSelect": true,
  "catalog": { "local": ["$LOCAL"], "cloud": ["$CLOUD"] },
  "local": { "maxConcurrent": $CAP, "maxConcurrentPerModel": ${PER_MODEL:-1}, "maxLoadedModels": ${MAX_LOADED:-1}, "onFull": "spill", "slotDir": "$DIR/slots" },
  "lmstudio": { "baseUrl": "$LMSTUDIO", "timeoutMs": 30000 }
}
EOF

peak_file="$DIR/peak"
echo 0 >"$peak_file"
done_file="$DIR/done"
sample() {
	local peak=0 count
	while [ ! -f "$done_file" ]; do
		count=$(find "$DIR/slots" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
		if [ "$count" -gt "$peak" ]; then
			peak="$count"
			echo "$peak" >"$peak_file"
		fi
		sleep 0.1
	done
}
sample &
sampler=$!

pids=()
for i in $(seq 1 "$N"); do
	(cd "$DIR" && PI_CUTTLE_DEBUG="$DIR/debug-$i.log" pi -p "Reply with exactly: ok" --model cuttle/auto -e "$EXT" --no-session >"$DIR/pi-$i.log" 2>&1) &
	pids+=("$!")
done

status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
touch "$done_file"
wait "$sampler" 2>/dev/null || true
peak=$(cat "$peak_file" 2>/dev/null || echo 0)
routed=$(cat "$DIR"/debug-*.log 2>/dev/null | grep -c "route result" || true)
local_routes=$(cat "$DIR"/debug-*.log 2>/dev/null | grep -c "tier=local" || true)

echo "fanout: $N processes, local cap $CAP"
echo "routed: $routed decision(s), $local_routes local"
echo "peak concurrent local slots: $peak"

# A cap that is never approached proves nothing (#59). These checks exist because the script
# used to print PASS whenever nothing happened at all: every process failed to load the
# extension, no slot was ever taken, and `0 -le cap` held.
if [ "$routed" -eq 0 ]; then
	echo "FAIL: no process produced a routing decision — the extension did not load."
	echo "      A '--cuttle-force' conflict means pi-cuttle is also installed as a package:"
	echo "      'pi remove git:github.com/saman-mb/pi-cuttle' and re-run this test."
	echo "--- first process output ---"
	tail -5 "$DIR/pi-1.log" 2>/dev/null || true
	exit 1
fi
if [ "$peak" -eq 0 ]; then
	echo "FAIL: no local slot was ever taken, so the cap was not exercised ($local_routes local route(s))."
	echo "      Every route spilled to cloud; check catalog.local and that LM Studio is up."
	grep -h "route result" "$DIR"/debug-*.log 2>/dev/null | head -3 || true
	exit 1
fi
if [ "$peak" -gt "$CAP" ]; then
	echo "FAIL: peak $peak > cap $CAP"
	exit 1
fi
if [ "$status" -ne 0 ]; then
	echo "FAIL: at least one pi process exited non-zero"
	grep -h -i "error" "$DIR"/pi-*.log 2>/dev/null | head -5 || true
	exit 1
fi
echo "PASS: cap held"
