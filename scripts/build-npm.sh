#!/bin/sh
# Builds the npm packages of the CLI into dist/npm from the release binaries in DIR (dist/pathlight-OS-ARCH, as scripts/build.sh writes them):
# `@dumbbunnyio/pathlight`, a launcher whose optional dependencies are one package per platform (`@dumbbunnyio/pathlight-linux-x64`…), each holding
# that platform's binary. npm installs only the one that matches the machine, and no install script runs. `pathlight` (unscoped) only points at it,
# so `npm i -g pathlight` keeps working. Publish the platform packages first, then `@dumbbunnyio/pathlight`, then `pathlight`.
# Usage: sh scripts/build-npm.sh [VERSION] [DIR]   (default: the root package.json version, and dist)
set -eu
cd "$(dirname "$0")/.."
version="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
binaries="${2:-dist}"
scope=@dumbbunnyio
out=dist/npm
rm -rf "$out"
mkdir -p "$out/pathlight" "$out/pointer"
repository='{ "type": "git", "url": "git+https://github.com/dumbbunnyio/pathlight.git" }'
optional=""
for binary in "$binaries"/pathlight-linux-* "$binaries"/pathlight-darwin-*; do
  [ -f "$binary" ] || continue
  platform=${binary##*/pathlight-}
  mkdir -p "$out/$platform/bin"
  cp "$binary" "$out/$platform/bin/pathlight"
  chmod 755 "$out/$platform/bin/pathlight"
  cp LICENSE NOTICE.md "$out/$platform/"
  cat > "$out/$platform/package.json" <<JSON
{
  "name": "$scope/pathlight-$platform",
  "version": "$version",
  "description": "The pathlight binary for ${platform}. Install $scope/pathlight instead; it picks this package for you.",
  "license": "MIT",
  "repository": $repository,
  "os": ["${platform%-*}"],
  "cpu": ["${platform#*-}"],
  "files": ["bin/pathlight", "LICENSE", "NOTICE.md"],
  "preferUnplugged": true
}
JSON
  optional="$optional${optional:+,
}    \"$scope/pathlight-$platform\": \"$version\""
done
[ -n "$optional" ] || { echo "no binaries in $binaries (run scripts/build.sh first)" >&2; exit 1; }
description="An architecture map of your codebase beside your coding agent in tmux: what the code is, and what the agent is touching as it works. For Claude Code and OpenCode."
keywords='["architecture", "likec4", "tmux", "claude-code", "opencode", "coding-agent", "diagram", "tui"]'
cp npm/launcher.cjs "$out/pathlight/launcher.cjs"
cp README.md LICENSE NOTICE.md "$out/pathlight/"
cat > "$out/pathlight/package.json" <<JSON
{
  "name": "$scope/pathlight",
  "version": "$version",
  "description": "$description",
  "license": "MIT",
  "repository": $repository,
  "homepage": "https://github.com/dumbbunnyio/pathlight#readme",
  "bin": { "pathlight": "launcher.cjs" },
  "files": ["launcher.cjs", "README.md", "LICENSE", "NOTICE.md"],
  "engines": { "node": ">=18" },
  "keywords": $keywords,
  "optionalDependencies": {
$optional
  }
}
JSON
cp npm/pointer.cjs "$out/pointer/pointer.cjs"
cp LICENSE "$out/pointer/"
printf '# pathlight\n\nInstalls [%s/pathlight](https://www.npmjs.com/package/%s/pathlight): `npm i -g pathlight` and `npm i -g %s/pathlight` are the same.\n' "$scope" "$scope" "$scope" > "$out/pointer/README.md"
cat > "$out/pointer/package.json" <<JSON
{
  "name": "pathlight",
  "version": "$version",
  "description": "$description Installs $scope/pathlight.",
  "license": "MIT",
  "repository": $repository,
  "homepage": "https://github.com/dumbbunnyio/pathlight#readme",
  "bin": { "pathlight": "pointer.cjs" },
  "files": ["pointer.cjs", "README.md", "LICENSE"],
  "engines": { "node": ">=18" },
  "keywords": $keywords,
  "dependencies": { "$scope/pathlight": "$version" }
}
JSON
ls "$out"
