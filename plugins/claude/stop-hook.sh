#!/bin/sh
root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd) || exit 0
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
# The turn's end goes on the session pointer (a time; the payload's text is never kept), then the map is refreshed against the code (one scan: the
# check, a drawn map's redraw, the diff). When the redraw drew boxes nobody has named, refresh exits 2 with one line for the agent, and this hook
# (async, asyncRewake) passes it on so the agent is woken once to have them named.
in=$(cat)
printf %s "$in" | bun "$root/src/cli.ts" record --workspace "$dir" >/dev/null 2>&1 || :
ask=$(printf %s "$in" | bun "$root/src/cli.ts" refresh --workspace "$dir" --hook claude 2>&1 >/dev/null)
[ $? -eq 2 ] && { printf '%s\n' "$ask" >&2; exit 2; }
exit 0
