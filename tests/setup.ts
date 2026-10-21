import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The user's saved theme must not change what the tests see: every viewer started from here reads an empty config directory unless a test names its own.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "pathlight-test-config-"));
