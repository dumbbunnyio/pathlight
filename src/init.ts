import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { acquireModel } from "./catalog";
import { hasCode, io, json, failure } from "./effects";

import pathlightSkill from "../plugins/claude/skills/pathlight/SKILL.md" with { type: "text" };
import behaviorSkill from "../plugins/claude/skills/pathlight-behavior/SKILL.md" with { type: "text" };

const pluginRoot = fileURLToPath(new URL("../plugins", import.meta.url));
/** The skills are compiled in, so `init` works from the single binary as well as from a checkout. */
const skillFiles: Record<string, string> = { pathlight: pathlightSkill, "pathlight-behavior": behaviorSkill };
/** Hook scripts and the OpenCode plugin are files in a checkout; a compiled binary has none, and the plugins supply them instead. */
const hasCheckout = (path: string) => existsSync(join(pluginRoot, path));
const hookEvents = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"] as const;

const kebab = (text: string) => text.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z\d]+/g, "-").replace(/^-|-$/g, "");

const readOptional = (path: string) => io("Init.read", () => readFile(path, "utf8")).pipe(
  Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed(undefined)));

const writeText = (path: string, text: string) => io("Init.write", async () => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the pathlight hooks to Claude's per-user project settings, keeping every other setting. */
export const claudeSettings = (current: unknown, hook: string): Record<string, unknown> & { hooks: Record<string, unknown[]> } => {
  const settings = isRecord(current) ? { ...current } : {};
  const hooks: Record<string, unknown[]> = {};
  if (isRecord(settings.hooks)) for (const [name, entries] of Object.entries(settings.hooks)) hooks[name] = Array.isArray(entries) ? entries : [];
  for (const event of hookEvents) {
    const entries = [...hooks[event] ?? []];
    const present = entries.some(entry => JSON.stringify(entry).includes("plugins/claude/hook.sh"));
    if (!present) entries.push({ hooks: [{ type: "command", command: `sh '${hook}'`, async: true }] });
    hooks[event] = entries;
  }
  // At the end of each turn, check the model against the code so the viewer can say when it has drifted.
  const stop = [...hooks.Stop ?? []];
  if (!stop.some(entry => JSON.stringify(entry).includes("plugins/claude/stop-hook.sh"))) stop.push({ hooks: [{ type: "command", command: `sh '${hook.replace(/hook\.sh$/, "stop-hook.sh")}'`, async: true }] });
  hooks.Stop = stop;
  return { ...settings, hooks };
};

/** Mappings only for names that exist on disk: a directory or file named like the element. */
export const proposeMappings = (elements: { id: string; title: string }[], paths: string[]) => {
  const directories = new Map<string, string>();
  const files = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split("/");
    parts.slice(0, -1).forEach((name, index) => {
      const key = kebab(name);
      if (key && !directories.has(key)) directories.set(key, `${parts.slice(0, index + 1).join("/")}/**`);
    });
    const file = kebab(basename(path, extname(path)));
    if (file && !files.has(file)) files.set(file, `${parts.slice(0, -1).concat(`${basename(path, extname(path))}.*`).join("/")}`);
  }
  return elements.flatMap(element => {
    const candidates = [...new Set([kebab(element.id.split(".").at(-1) ?? ""), kebab(element.title)].filter(Boolean))];
    const glob = candidates.map(name => directories.get(name) ?? files.get(name)).find(Boolean);
    return glob ? [{ glob, element: element.id }] : [];
  });
};

const listFiles = Effect.fn("Init.files")(function* (workspace: string) {
  const excluded = new Set([".git", ".cache", "node_modules", ".claude"]);
  const found: string[] = [];
  const walk = (directory: string): Effect.Effect<void, ReturnType<typeof failure>> => Effect.gen(function* () {
    for (const entry of yield* io("Init.entries", () => readdir(join(workspace, directory), { withFileTypes: true }))) {
      if (found.length > 20_000) return;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !excluded.has(entry.name)) yield* walk(path);
      else if (entry.isFile()) found.push(path);
    }
  });
  yield* walk("");
  return found;
});

export const initWorkspace = Effect.fn("Init.workspace")(function* (path: string, options: { claudeHooks: boolean } = { claudeHooks: true }) {
  const workspace = yield* io("Init.workspace", () => realpath(path));
  const notes: string[] = [];

  if (options.claudeHooks && !hasCheckout("claude/hook.sh")) notes.push("Claude Code: install the pathlight plugin for the hooks (none were written from this binary).");
  else if (options.claudeHooks) {
    const settingsPath = join(workspace, ".claude", "settings.local.json");
    const existing = yield* readOptional(settingsPath);
    const settings = claudeSettings(existing ? yield* json(existing) : {}, join(pluginRoot, "claude", "hook.sh"));
    yield* writeText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    notes.push("Claude Code: hooks added to .claude/settings.local.json (per-user, not shared).");

  } else notes.push("Claude Code: no local hooks written (using the plugin).");

  // The skills are the same files for both hosts. Claude Code reads .claude/skills; with the plugin installed it supplies them itself,
  // so only OpenCode needs a copy, and its documentation lists .agents/skills (and .claude/skills) as places it looks.
  const skillRoot = options.claudeHooks ? ".claude" : ".agents";
  const skills = Object.keys(skillFiles).sort();
  for (const name of skills) yield* writeText(join(workspace, skillRoot, "skills", name, "SKILL.md"), skillFiles[name]!);
  notes.push(options.claudeHooks ? `Skills: ${skills.join(", ")} written to .claude/skills (Claude Code; OpenCode documents reading it too).`
    : `Skills: ${skills.join(", ")} written to .agents/skills for OpenCode (the Claude plugin supplies them to Claude Code).`);

  const configPath = join(workspace, "pathlight.activity.json");
  if (yield* readOptional(configPath)) notes.push("Activity: kept existing pathlight.activity.json.");
  else {
    const proposal = yield* Effect.gen(function* () {
      const source = yield* acquireModel(workspace);
      const [project] = [...source.projects()];
      if (!project) return undefined;
      const model = yield* io("LikeC4.compute", () => source.computedModel(project));
      const elements = [...model.elements()].map(element => ({ id: String(element.id), title: element.title }));
      return { project, mappings: proposeMappings(elements, yield* listFiles(workspace)), elements: elements.length };
    }).pipe(Effect.scoped, Effect.catch(() => Effect.succeed(undefined)));
    if (!proposal) notes.push("Activity: no LikeC4 project found, so pathlight.activity.json was not created.");
    else {
      yield* writeText(configPath, `${JSON.stringify({ version: 1, project: proposal.project, mappings: proposal.mappings }, null, 2)}\n`);
      notes.push(`Activity: mapped ${proposal.mappings.length} of ${proposal.elements} elements by matching names on disk. Review pathlight.activity.json and add globs for the rest.`);
    }
  }

  const opencodePath = join(workspace, "opencode.json");
  const opencode = yield* readOptional(opencodePath);
  const config = opencode ? yield* json(opencode) : { $schema: "https://opencode.ai/config.json" };
  if (isRecord(config) && !hasCheckout("opencode/index.ts")) notes.push("OpenCode: add the pathlight plugin to opencode.json (none was registered from this binary).");
  else if (isRecord(config)) {
    const plugin = join(pluginRoot, "opencode");
    const plugins: unknown[] = Array.isArray(config.plugins) ? [...config.plugins] : [];
    // `record: true` is the OpenCode counterpart of installing the Claude hooks: running init is the opt-in to record this workspace's root sessions.
    const index = plugins.findIndex(entry => entry === plugin || (isRecord(entry) && entry.package === plugin));
    const entry = plugins[index];
    const options = isRecord(entry) && isRecord(entry.options) ? entry.options : {};
    if (index < 0) {
      plugins.push({ package: plugin, options: { record: true } });
      notes.push("OpenCode: plugin registered in opencode.json with recording on (restart the OpenCode service). Use /pathlight-open, or /pathlight to ask the agent.");
    } else if (options.record === undefined) {
      plugins[index] = { ...(isRecord(entry) ? entry : { package: plugin }), options: { ...options, record: true } };
      notes.push("OpenCode: plugin was registered; recording turned on (restart the OpenCode service).");
    } else notes.push(`OpenCode: plugin already registered (recording ${options.record === true ? "on" : "off, as configured"}).`);
    if (index < 0 || options.record === undefined) yield* writeText(opencodePath, `${JSON.stringify({ ...config, plugins }, null, 2)}\n`);
  }
  return notes;
});
