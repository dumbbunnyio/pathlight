#!/bin/sh
root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd) || exit 0
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
# The turn's end goes on the session pointer (a time; the payload's text is never kept), then the model is checked against the code.
bun "$root/src/cli.ts" record --workspace "$dir" >/dev/null 2>&1 || :
bun "$root/src/cli.ts" check --workspace "$dir" --quiet >/dev/null 2>&1 || :
bun "$root/src/cli.ts" diff --workspace "$dir" --quiet >/dev/null 2>&1 || :
