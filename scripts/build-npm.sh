#!/bin/sh
# Builds the npm packages of the CLI into dist/npm from the release binaries in DIR (dist/pathlight-OS-ARCH, as scripts/build.sh writes them):
# `pathlight`, a launcher whose optional dependencies are one package per platform (`pathlight-linux-x64`…), each holding that platform's binary.
# npm installs only the one that matches the machine, and no install script runs. Publish the platform packages before `pathlight`.
# Usage: sh scripts/build-npm.sh [VERSION] [DIR]   (default: the root package.json version, and dist)
set -eu
cd "$(dirname "$0")/.."
version="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
binaries="${2:-dist}"
out=dist/npm
rm -rf "$out"
mkdir -p "$out/pathlight"
repository='{ "type": "git", "url": "git+https://github.com/lennox-davidlevy/pathlight.git" }'
optional=""
for binary in "$binaries"/pathlight-linux-* "$binaries"/pathlight-darwin-*; do
  [ -f "$binary" ] || continue
  name=$(basename "$binary")
  platform=${name#pathlight-}
  mkdir -p "$out/$name/bin"
  cp "$binary" "$out/$name/bin/pathlight"
  chmod 755 "$out/$name/bin/pathlight"
  cp LICENSE NOTICE.md "$out/$name/"
  cat > "$out/$name/package.json" <<JSON
{
  "name": "$name",
  "version": "$version",
  "description": "The pathlight binary for ${platform}. Install pathlight instead; it picks this package for you.",
  "license": "MIT",
  "repository": $repository,
  "os": ["${platform%-*}"],
  "cpu": ["${platform#*-}"],
  "files": ["bin/pathlight", "LICENSE", "NOTICE.md"],
  "preferUnplugged": true
}
JSON
  optional="$optional${optional:+,
}    \"$name\": \"$version\""
done
[ -n "$optional" ] || { echo "no binaries in $binaries (run scripts/build.sh first)" >&2; exit 1; }
cp npm/launcher.cjs "$out/pathlight/launcher.cjs"
cp README.md LICENSE NOTICE.md "$out/pathlight/"
cat > "$out/pathlight/package.json" <<JSON
{
  "name": "pathlight",
  "version": "$version",
  "description": "An architecture map of your codebase beside your coding agent in tmux: what the code is, and what the agent is touching as it works. For Claude Code and OpenCode.",
  "license": "MIT",
  "repository": $repository,
  "homepage": "https://github.com/lennox-davidlevy/pathlight#readme",
  "bin": { "pathlight": "launcher.cjs" },
  "files": ["launcher.cjs", "README.md", "LICENSE", "NOTICE.md"],
  "engines": { "node": ">=18" },
  "keywords": ["architecture", "likec4", "tmux", "claude-code", "opencode", "coding-agent", "diagram", "tui"],
  "optionalDependencies": {
$optional
  }
}
JSON
ls "$out"
