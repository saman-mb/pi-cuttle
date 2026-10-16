#!/usr/bin/env bash
#
# Re-render the committed README badges (#55).
#
# The badges in docs/badges/ are deterministic, offline SVGs: the same claim renders
# byte-for-byte the same. That determinism is what lets test/badges.test.ts assert
# their text, so this script is the single command that fixes a failing badge test.
#
# The renderer is the shipmates badge tool (pure standard library, no network). If
# it is not at the default path, point SHIPMATES_BADGE at badge.py from a checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

renderer="${SHIPMATES_BADGE:-$HOME/.pi/agent/skills/shipmates-badge/badge.py}"

if ! command -v python3 >/dev/null 2>&1; then
	echo "render-badges: python3 is required" >&2
	exit 1
fi
if [ ! -f "$renderer" ]; then
	echo "render-badges: badge renderer not found at $renderer" >&2
	echo "  set SHIPMATES_BADGE=/path/to/badge.py, or hand-edit docs/badges/*.svg" >&2
	echo "  (keep each SVG internally consistent: aria-label '<label>: <message>')" >&2
	exit 1
fi

version="$(node -p "require('./package.json').version")"

# The tests badge deliberately carries no count: a count goes stale the moment a
# test is added (#55). "passing" is enforced by CI, not by this file.
python3 "$renderer" --label tests --message "passing" --color green --out docs/badges/tests.svg
python3 "$renderer" --label version --message "v$version" --color purple --out docs/badges/version.svg
python3 "$renderer" --label license --message "MIT" --color blue --out docs/badges/license.svg

echo "render-badges: wrote docs/badges/{tests,version,license}.svg (version v$version)"
