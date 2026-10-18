import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { acquireModel } from "./catalog";
import { hasCode, io, json, failure } from "./effects";

const pluginRoot = fileURLToPath(new URL("../plugins", import.meta.url));
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const hookEvents = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

const kebab = (text: string) => text.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z\d]+/g, "-").replace(/^-|-$/g, "");

const readOptional = (path: string) => io("Init.read", () => readFile(path, "utf8")).pipe(
  Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed(undefined)));

const writeText = (path: string, text: string) => io("Init.write", async () => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the c4view hooks to Claude's per-user project settings, keeping every other setting. */
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

const slashCommand = `---
description: Open the live architecture diagram beside this conversation
argument-hint: [view-id]
allowed-tools: Bash(bun ${cli}:*)
---
Open the live architecture viewer in the user's tmux window. It follows this session's tool activity.

- If a view ID was given ($ARGUMENTS), run:
  \`bun '${cli}' show $ARGUMENTS --workspace "$CLAUDE_PROJECT_DIR" --follow\`
- Otherwise run \`bun '${cli}' list --workspace "$CLAUDE_PROJECT_DIR"\`, choose the most useful overview view, and show that one.

Report only whether the viewer opened. Do not describe the diagram from memory.
`;

export const initWorkspace = Effect.fn("Init.workspace")(function* (path: string) {
  const workspace = yield* io("Init.workspace", () => realpath(path));
  const notes: string[] = [];

  const settingsPath = join(workspace, ".claude", "settings.local.json");
  const existing = yield* readOptional(settingsPath);
  const settings = claudeSettings(existing ? yield* json(existing) : {}, join(pluginRoot, "claude", "hook.sh"));
  yield* writeText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  notes.push("Claude Code: hooks added to .claude/settings.local.json (per-user, not shared).");

  yield* writeText(join(workspace, ".claude", "commands", "c4view.md"), slashCommand);
  notes.push("Claude Code: /c4view [view] opens the live viewer in your tmux window.");

  const configPath = join(workspace, "c4view.activity.json");
  if (yield* readOptional(configPath)) notes.push("Activity: kept existing c4view.activity.json.");
  else {
    const proposal = yield* Effect.gen(function* () {
      const source = yield* acquireModel(workspace);
      const [project] = [...source.projects()];
      if (!project) return undefined;
      const model = yield* io("LikeC4.compute", () => source.computedModel(project));
      const elements = [...model.elements()].map(element => ({ id: String(element.id), title: element.title }));
      return { project, mappings: proposeMappings(elements, yield* listFiles(workspace)), elements: elements.length };
    }).pipe(Effect.scoped, Effect.catch(() => Effect.succeed(undefined)));
    if (!proposal) notes.push("Activity: no LikeC4 project found, so c4view.activity.json was not created.");
    else {
      yield* writeText(configPath, `${JSON.stringify({ version: 1, project: proposal.project, mappings: proposal.mappings }, null, 2)}\n`);
      notes.push(`Activity: mapped ${proposal.mappings.length} of ${proposal.elements} elements by matching names on disk. Review c4view.activity.json and add globs for the rest.`);
    }
  }

  const opencodePath = join(workspace, "opencode.json");
  const opencode = yield* readOptional(opencodePath);
  const config = opencode ? yield* json(opencode) : { $schema: "https://opencode.ai/config.json" };
  if (isRecord(config)) {
    const plugin = join(pluginRoot, "opencode");
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    if (!plugins.includes(plugin)) {
      yield* writeText(opencodePath, `${JSON.stringify({ ...config, plugins: [...plugins, plugin] }, null, 2)}\n`);
      notes.push("OpenCode: plugin registered in opencode.json. Restart the service, then ask for the diagram with live=true.");
    } else notes.push("OpenCode: plugin already registered.");
  }
  return notes;
});
