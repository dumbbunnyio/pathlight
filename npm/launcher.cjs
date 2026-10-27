#!/usr/bin/env node
// `npm i -g @dumbbunnyio/pathlight` puts this on the PATH; the binary itself comes in the package for this platform (@dumbbunnyio/pathlight-OS-ARCH),
// which npm installs as an optional dependency and skips on every other platform. It says whose child it is so that `pathlight open`
// typed at a shell prompt still takes over that pane rather than splitting beside it (src/tmux.ts, atShellPrompt).
"use strict";
const { spawnSync } = require("node:child_process");

const name = `@dumbbunnyio/pathlight-${process.platform}-${process.arch}`;
let binary;
try {
  binary = require.resolve(`${name}/bin/pathlight`);
} catch {
  console.error(`pathlight: no build for ${process.platform}-${process.arch} was installed (${name}). Builds exist for linux and darwin, x64 and arm64.
If your package manager skipped optional dependencies, reinstall without --no-optional, or use:
  curl -fsSL https://raw.githubusercontent.com/dumbbunnyio/pathlight/main/install.sh | sh`);
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, PATHLIGHT_LAUNCHER_PID: String(process.pid), PATHLIGHT_LAUNCHER_PPID: String(process.ppid) },
});
if (result.error) {
  console.error(`pathlight: could not run ${binary}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
