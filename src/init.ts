import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { acquireModel } from "./catalog";
import { mappingPath } from "./layout";
import { hasCode, io, json, failure } from "./effects";

import pathlightSkill from "../plugins/claude/skills/pathlight/SKILL.md" with { type: "text" };
import behaviorSkill from "../plugins/claude/skills/pathlight-behavior/SKILL.md" with { type: "text" };

const pluginRoot = fileURLToPath(new URL("../plugins", import.meta.url));
/** The skills are compiled in, so `init` works from the single binary as well as from a checkout. */
const skillFiles: Record<string, string> = { pathlight: pathlightSkill, "pathlight-behavior": behaviorSkill };
/** Hook scripts and the OpenCode plugin are files in a checkout; a compiled binary has none, and the plugins supply them instead. */
const hasCheckout = (path: string) => existsSync(join(pluginRoot, path));

/** Whether the Claude Code plugin is installed for this user. A skill in a project's `.claude/skills` outranks the plugin's own, so a copy written before the plugin arrived keeps its old text through every update. */
export const claudePluginInstalled = () => {
  try {
    const installed: unknown = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "plugins", "installed_plugins.json"), "utf8"));
    const plugins = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {};
    return Object.keys(plugins).some(key => key.startsWith("pathlight@"));
  } catch { return false; }
};

/** The skill copies in a project's `.claude/skills` that Pathlight wrote (matched by the name in their front matter, so a person's own skill of another name is never touched). */
export const projectSkillCopies = (workspace: string) => Object.keys(skillFiles).map(name => join(workspace, ".claude", "skills", name, "SKILL.md")).filter(path => {
  try { return new RegExp(`^name: ${basename(dirname(path))}\\s*$`, "m").test(readFileSync(path, "utf8").slice(0, 400)); } catch { return false; }
});

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

  // The skills are the same files for both hosts. Claude Code reads .claude/skills, but a copy there outranks the plugin's skill and goes stale
  // when the plugin updates, so with the plugin installed none is written and an earlier one is removed. OpenCode documents .agents/skills (and .claude/skills).
  const plugin = options.claudeHooks && claudePluginInstalled();
  const skillRoot = options.claudeHooks ? ".claude" : ".agents";
  const skills = Object.keys(skillFiles).sort();
  if (plugin) {
    const removed = projectSkillCopies(workspace);
    for (const path of removed) yield* io("Init.remove", () => rm(dirname(path), { recursive: true }));
    notes.push(removed.length ? `Skills: removed the copies in .claude/skills (${removed.length}); the installed plugin supplies them and a copy would hide its updates.`
      : "Skills: the installed plugin supplies them to Claude Code, so none were written to .claude/skills.");
  } else for (const name of skills) yield* writeText(join(workspace, skillRoot, "skills", name, "SKILL.md"), skillFiles[name]!);
  if (!plugin) notes.push(options.claudeHooks ? `Skills: ${skills.join(", ")} written to .claude/skills (Claude Code; OpenCode documents reading it too).`
    : `Skills: ${skills.join(", ")} written to .agents/skills for OpenCode (the Claude plugin supplies them to Claude Code).`);

  const configPath = mappingPath(workspace);
  if (yield* readOptional(configPath)) notes.push("Activity: kept existing .pathlight/pathlight.activity.json.");
  else {
    const proposal = yield* Effect.gen(function* () {
      const source = yield* acquireModel(workspace);
      const [project] = [...source.projects()];
      if (!project) return undefined;
      const model = yield* io("LikeC4.compute", () => source.computedModel(project));
      const elements = [...model.elements()].map(element => ({ id: String(element.id), title: element.title }));
      return { project, mappings: proposeMappings(elements, yield* listFiles(workspace)), elements: elements.length };
    }).pipe(Effect.scoped, Effect.catch(() => Effect.succeed(undefined)));
    // With no model files LikeC4 still reports an empty default project: a mapping of nothing would only stop `setup` from drawing a first model.
    if (!proposal || proposal.elements === 0) notes.push("Activity: no model yet, so .pathlight/pathlight.activity.json was not created. Run pathlight setup --yes to draw one from the code (it writes the mapping too).");
    else {
      yield* writeText(configPath, `${JSON.stringify({ version: 1, project: proposal.project, mappings: proposal.mappings }, null, 2)}\n`);
      notes.push(`Activity: mapped ${proposal.mappings.length} of ${proposal.elements} elements by matching names on disk. Review .pathlight/pathlight.activity.json and add globs for the rest.`);
    }
  }

  // Registered for every project already, a second entry here would load the plugin twice and record every call twice.
  const global = yield* openCodeEntry(join(openCodeConfigDir(), "opencode.json"));
  if (global) notes.push(`OpenCode: the plugin is registered for every project in ${join(openCodeConfigDir(), "opencode.json")} (recording ${global.record === true ? "on" : "off, as configured"}), so none was added to this one.`);
  else notes.push(yield* registerOpenCode(join(workspace, "opencode.json"), "opencode.json"));
  return notes;
});

/** OpenCode's own configuration folder, where it looks for the configuration that applies to every project. */
export const openCodeConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

// From a checkout the plugin is its folder; the compiled binary has none, so it registers the npm package, which OpenCode installs itself.
const openCodePlugin = () => hasCheckout("opencode/index.ts") ? join(pluginRoot, "opencode") : "pathlight-opencode";
const isPathlightPlugin = (entry: unknown) => {
  const name = isRecord(entry) ? entry.package : entry;
  return typeof name === "string" && (/^pathlight-opencode(@|$)/.test(name) || name === openCodePlugin());
};

/** The pathlight entry of an OpenCode configuration file, with its options, if it has one. */
const openCodeEntry = (path: string) => readOptional(path).pipe(Effect.map(text => {
  try {
    const config: unknown = text === undefined ? undefined : JSON.parse(text);
    const entry = isRecord(config) && Array.isArray(config.plugins) ? config.plugins.find(isPathlightPlugin) : undefined;
    return entry === undefined ? undefined : isRecord(entry) && isRecord(entry.options) ? entry.options : {};
  } catch { return undefined; }
}));

/** Adds the plugin to an OpenCode configuration file with recording on, keeping everything else in it. */
const registerOpenCode = Effect.fn("Init.opencode")(function* (path: string, shown: string) {
  // OpenCode also reads opencode.jsonc; a file with comments is left to the person rather than rewritten without them.
  if (!(yield* readOptional(path)) && (yield* readOptional(`${path}c`))) return `OpenCode: ${shown}c has comments pathlight will not rewrite. Add to its "plugins": { "package": "${openCodePlugin()}", "options": { "record": true } }`;
  const opencode = yield* readOptional(path);
  const config = opencode ? yield* json(opencode) : { $schema: "https://opencode.ai/config.json" };
  if (!isRecord(config)) return `OpenCode: ${shown} is not a JSON object; left as it is.`;
  const plugins: unknown[] = Array.isArray(config.plugins) ? [...config.plugins] : [];
  // `record: true` is the OpenCode counterpart of installing the Claude hooks: running init is the opt-in to record root sessions (the plugin records only where there is a mapping).
  const index = plugins.findIndex(isPathlightPlugin);
  const entry = plugins[index];
  const options = isRecord(entry) && isRecord(entry.options) ? entry.options : {};
  if (index >= 0 && options.record !== undefined) return `OpenCode: plugin already registered (recording ${options.record === true ? "on" : "off, as configured"}) in ${shown}.`;
  if (index < 0) plugins.push({ package: openCodePlugin(), options: { record: true } });
  else plugins[index] = { ...(isRecord(entry) ? entry : { package: entry }), options: { ...options, record: true } };
  yield* writeText(path, `${JSON.stringify({ ...config, plugins }, null, 2)}\n`);
  return index < 0 ? `OpenCode: plugin registered in ${shown} with recording on (restart OpenCode). Use /pathlight-open, or /pathlight to ask the agent.`
    : `OpenCode: plugin was registered in ${shown}; recording turned on (restart OpenCode).`;
});

/** `init --global`: the OpenCode plugin for every project, the counterpart of installing the Claude plugin once. It records only in projects with a mapping. */
export const initGlobal = Effect.fn("Init.global")(function* () {
  const path = join(openCodeConfigDir(), "opencode.json");
  return [
    yield* registerOpenCode(path, path),
    "Claude Code: install the plugin once for every project: claude plugin marketplace add lennox-davidlevy/pathlight && claude plugin install pathlight@pathlight",
    "Then in a project: /pathlight in your agent, or pathlight setup --yes.",
  ];
});
