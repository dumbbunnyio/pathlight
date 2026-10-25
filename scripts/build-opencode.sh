#!/bin/sh
# Builds the npm package for the OpenCode plugin into plugins/opencode/dist (git-ignored): the plugin and everything it shares with the CLI bundled
# into two files, the skills and the tracer prompt carried inside, nothing read from a checkout. `effect` and OpenCode's own packages are not bundled:
# OpenCode supplies them to every plugin. Usage: sh scripts/build-opencode.sh [VERSION]   (default: the root package.json version)
set -eu
cd "$(dirname "$0")/.."
version="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
out=plugins/opencode/dist
rm -rf "$out"
mkdir -p "$out/skills"
bun build plugins/opencode/index.ts plugins/opencode/tui.ts --outdir "$out" --target bun \
  --external effect --external 'effect/*' --external @opencode/plugin --external '@opencode/plugin/*'
cp -R plugins/claude/skills/. "$out/skills/"
# No license field or file is written: the repository has none yet, and the package must not claim one.
[ ! -f LICENSE ] || cp LICENSE "$out/LICENSE"
cat > "$out/package.json" <<JSON
{
  "name": "pathlight-opencode",
  "version": "$version",
  "description": "Pathlight for OpenCode: records which components the agent touches, opens the architecture viewer beside the conversation, and a Sonnet-sized tracer agent that records flows.",
  "type": "module",
  "exports": { ".": "./index.js", "./tui": "./tui.js" },
  "files": ["index.js", "tui.js", "skills", "README.md", "LICENSE"],
  "peerDependencies": { "effect": "^4.0.0" },
  "keywords": ["opencode", "opencode-plugin", "architecture", "likec4", "tmux"],
  "repository": { "type": "git", "url": "git+https://github.com/lennox-davidlevy/pathlight.git", "directory": "plugins/opencode" }
}
JSON
cp plugins/opencode/README.md "$out/README.md"
echo "built $out ($version)"
