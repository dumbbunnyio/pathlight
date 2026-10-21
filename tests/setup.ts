import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The user's saved theme must not change what the tests see: every viewer started from here reads an empty config directory unless a test names its own.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "pathlight-test-config-"));

// Terminal tests start a tmux server on `/tmp/c4*-<pid>.sock`. `tmux kill-server` stops the server but leaves the socket file, and the pid never repeats, so they pile up.
afterAll(() => {
  for (const name of readdirSync("/tmp")) if (new RegExp(`^c4[a-z]*-${process.pid}(-[a-z0-9]+)?\\.sock$`).test(name)) rmSync(join("/tmp", name), { force: true });
});
