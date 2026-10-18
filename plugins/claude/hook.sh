#!/bin/sh
root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd) || exit 0
bun "$root/src/cli.ts" record --workspace "${CLAUDE_PROJECT_DIR:-$PWD}" >/dev/null 2>&1 || :
