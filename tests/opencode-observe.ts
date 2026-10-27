import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

export interface Observed {
  agent: { mode: string; model: { providerID: string; id: string } | null; rules: number; system: string } | null;
  skills: string[];
}

/**
 * The real OpenCode runtime, offline, with `plugin` (a folder) loaded as the plugin under test. A second plugin, loaded after it, reads back from the host
 * what the first registered: the tracer agent and the skills. Providers need credentials to count as enabled, so a placeholder Anthropic key in `env` is
 * enough for the host to list its models; no request is ever made. `pathlight` on the PATH is the repository's CLI.
 * With `global`, the plugin is not in the project's configuration: `pathlight init --global` registers it in OpenCode's own (isolated) one.
 */
export async function observeOpenCode(plugin: string, env: string[], options: { global?: boolean } = {}): Promise<Observed> {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-opencode-observe-"));
  const socket = join("/tmp", `c4ob-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    const workspace = join(directory, "work"), probe = join(directory, "probe"), out = join(directory, "out.json");
    await mkdir(workspace); await mkdir(probe); await mkdir(join(directory, "bin"));
    await writeFile(join(probe, "package.json"), JSON.stringify({ name: "probe", private: true, type: "module", exports: { ".": "./index.ts" } }));
    await writeFile(join(probe, "index.ts"), `import { Plugin } from "@opencode/plugin";
import { writeFileSync } from "node:fs";
export default Plugin.define({ id: "probe", setup: async ctx => {
  const skills = (await ctx.skill.list()).data.map(skill => String(skill.id)).sort();
  await ctx.agent.transform(editor => {
    const t = editor.get("pathlight-tracer") as Record<string, unknown> | undefined;
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({ skills, agent: t ? { mode: t.mode, model: t.model ?? null, rules: (t.permissions as unknown[]).length, system: String(t.system) } : null }));
  });
} });
`);
    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", model: "fake/m",
      providers: { fake: { name: "Fake", env: ["FAKE_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:9/v1" }, models: { m: { name: "Fake" } } } },
      plugins: [...options.global ? [] : [{ package: plugin, options: {} }], { package: probe, options: {} }],
    }));
    if (options.global) await run("env", [`XDG_CONFIG_HOME=${join(directory, "config")}`, process.execPath, resolve("src/cli.ts"), "init", "--global"]);
    await writeFile(join(directory, "bin", "pathlight"), `#!/bin/sh\nexec ${process.execPath} ${resolve("src/cli.ts")} "$@"\n`);
    await chmod(join(directory, "bin", "pathlight"), 0o755);
    const dirs = ["config", "data", "state", "cache"].map(name => `XDG_${name.toUpperCase()}_HOME=${join(directory, name)}`);
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "oc", "-x", "150", "-y", "40", "-c", workspace, "env", "FAKE_KEY=x", `PATH=${join(directory, "bin")}:${process.env.PATH}`, ...env, ...dirs, Bun.which("opencode")!, "--standalone");
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await readFile(out, "utf8").catch(() => "")) { await delay(1500); return JSON.parse(await readFile(out, "utf8")) as Observed; }
      await delay(200);
    }
    throw new Error(`OpenCode never reported:\n${await tmux("capture-pane", "-p", "-t", "oc")}`);
  } finally {
    await tmux("kill-server").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
