#!/bin/sh
root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd) || exit 0
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
bun "$root/src/cli.ts" check --workspace "$dir" --quiet >/dev/null 2>&1 || :
bun "$root/src/cli.ts" diff --workspace "$dir" --quiet >/dev/null 2>&1 || :
