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
for _ in $(seq 1 "$N"); do
	(cd "$DIR" && pi -p "Reply with exactly: ok" --model cuttle/auto -e "$EXT" --no-session >/dev/null 2>&1) &
	pids+=("$!")
done

status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
touch "$done_file"
wait "$sampler" 2>/dev/null || true
peak=$(cat "$peak_file" 2>/dev/null || echo 0)

echo "fanout: $N processes, local cap $CAP"
echo "peak concurrent local slots: $peak"
if [ "$peak" -le "$CAP" ]; then
	echo "PASS: cap held"
	exit "$status"
fi
echo "FAIL: $peak > $CAP"
exit 1
