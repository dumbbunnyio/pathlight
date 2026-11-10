import { dirname, relative, resolve } from "node:path";
import { Config, Effect } from "effect";
import { listViews } from "./catalog";
import { readActivityConfig } from "./activity";
import { io } from "./effects";
import { run } from "./process";
import { claudePluginInstalled, hasPathlightPermission, pathlightPermission, projectSkillCopies } from "./init";
import pkg from "../package.json" with { type: "json" };

/** One line of the report: `fix` is what to do, shown only when the check failed. `info` is not a problem, just what was found. */
export interface Finding { readonly name: string; readonly status: "ok" | "fail" | "info"; readonly detail: string; readonly fix?: string }

const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");

/** Checks what the viewer needs from the machine and the workspace, and says how to fix each failure. Nothing is changed. */
export const doctor = Effect.fn("Doctor.run")(function* (workspace: string) {
  const root = resolve(workspace);
  const found: Finding[] = [];
  const add = (finding: Finding) => { found.push(finding); };
  add({ name: "pathlight", status: "ok", detail: `${pkg.version}, ${compiled ? "single binary" : "running from source with Bun"}, ${process.platform}/${process.arch}` });
  if (process.platform !== "linux") add({ name: "platform", status: "info", detail: `${process.platform} has not been verified; Linux with tmux is the tested setup` });

  const onPath = yield* run("sh", ["-c", "command -v pathlight"]).pipe(Effect.option);
  if (onPath._tag === "Some") add({ name: "on PATH", status: "ok", detail: onPath.value });
  else add({ name: "on PATH", status: "fail", detail: "the plugins' hooks call `pathlight`, and it was not found", fix: compiled ? "Put the pathlight binary in a directory on your PATH." : "Run `bun link` in the pathlight repository." });

  const tmux = yield* run("tmux", ["-V"]).pipe(Effect.option);
  if (tmux._tag === "Some") add({ name: "tmux", status: "ok", detail: tmux.value });
  else add({ name: "tmux", status: "fail", detail: "not installed", fix: "Install tmux (for example `brew install tmux` or `apt install tmux`)." });
  const inside = yield* Config.String("TMUX").pipe(Config.withDefault(""));
  add(inside ? { name: "inside tmux", status: "ok", detail: "this shell is in a tmux pane" } : { name: "inside tmux", status: "info", detail: "this shell is not in tmux; open the viewer from a tmux pane, or use `pathlight open --here`" });

  const views = yield* listViews(root).pipe(Effect.option);
  if (views._tag === "Some" && views.value.views.length) add({ name: "model", status: "ok", detail: `${views.value.views.length} views in ${root}` });
  else add({ name: "model", status: "fail", detail: `no LikeC4 model found in ${root}`, fix: "Run `pathlight draft --workspace .` to draw one from the code, or write a LikeC4 model." });
  const config = yield* readActivityConfig(root).pipe(Effect.option);
  if (config._tag === "Some") add({ name: "file mapping", status: "ok", detail: `${config.value.mappings.length} mappings in .pathlight/pathlight.activity.json` });
  else add({ name: "file mapping", status: "fail", detail: ".pathlight/pathlight.activity.json is missing or invalid", fix: "Run `pathlight draft --workspace .` (or `pathlight init`), then `pathlight check`." });

  const claude = yield* run("sh", ["-c", "command -v claude"]).pipe(Effect.option);
  if (claude._tag === "Some") {
    const plugins = yield* run("claude", ["plugin", "list"]).pipe(Effect.option);
    add(plugins._tag === "Some" && /pathlight/.test(plugins.value)
      ? { name: "Claude Code", status: "ok", detail: "the pathlight plugin is installed" }
      : { name: "Claude Code", status: "info", detail: "the pathlight plugin was not found (hooks are what record activity)", fix: "Run `claude plugin marketplace add dumbbunnyio/pathlight` then `claude plugin install pathlight`." });
  } else add({ name: "Claude Code", status: "info", detail: "not installed here" });
  if (claude._tag === "Some") add(hasPathlightPermission(root) ? { name: "permission", status: "ok", detail: `.claude/settings.json allows ${pathlightPermission}` }
    : { name: "permission", status: "info", detail: `Claude Code will ask before each pathlight command the agent runs (name, flow add, plan)`, fix: `Run \`pathlight init\`, or add "${pathlightPermission}" to permissions.allow in .claude/settings.json.` });
  const copies = claudePluginInstalled() ? projectSkillCopies(root) : [];
  if (copies.length) add({ name: "old skills", status: "fail", detail: "this project has its own copy of the pathlight skills in .claude/skills, which hides the plugin's newer ones", fix: `Run \`pathlight init\` to remove them, or delete ${copies.map(path => relative(root, dirname(path))).join(" and ")}.` });
  // The browser page (pathlight web): whether this copy has it, and the browser --open and B would use.
  const page = yield* io("Doctor.page", () => import("./web/page").then(module => module.loadPage("page"))).pipe(Effect.option);
  add(page._tag === "Some" && page.value ? { name: "browser page", status: "ok", detail: "ready (pathlight web)" }
    : { name: "browser page", status: "info", detail: "not built in this copy, so pathlight web shows how to build it", fix: "In a checkout, run `bun scripts/build-page.ts`." });
  const browser = yield* io("Doctor.browser", () => import("./web/launch")).pipe(Effect.flatMap(module => module.findBrowser()), Effect.option);
  const opener = browser._tag === "Some" ? browser.value : undefined;
  add(opener ? { name: "browser", status: opener.app ? "ok" : "info", detail: opener.app ? `${opener.name} (${opener.command[0]}) opens the map in a window of its own` : `${opener.name} opens the map in a tab`, ...(opener.app ? {} : { fix: "Install a Chromium-family browser, or name one with `pathlight config set browser COMMAND`, for a window of its own." }) }
    : { name: "browser", status: "info", detail: "none found, so pathlight web --open and B cannot open a window", fix: "Name one with `pathlight config set browser COMMAND`, or open the address pathlight web prints." });
  const editor = yield* Config.String("VISUAL").pipe(Config.withDefault(""), Effect.flatMap(visual => visual ? Effect.succeed(visual) : Config.String("EDITOR").pipe(Config.withDefault(""))));
  add(editor ? { name: "editor", status: "ok", detail: `${editor} opens files from the viewer` }
    : { name: "editor", status: "info", detail: "neither VISUAL nor EDITOR is set, so opening a file from the viewer will fail", fix: "Set VISUAL or EDITOR, for example `export EDITOR=nvim`." });
  return found;
});

export const formatDoctor = (findings: readonly Finding[]) => `${findings.map(item => `${item.status === "ok" ? "✓" : item.status === "fail" ? "✗" : "·"} ${item.name.padEnd(13)} ${item.detail}${item.status !== "ok" && item.fix ? `\n    fix: ${item.fix}` : ""}`).join("\n")}\n`;
export const hasFailures = (findings: readonly Finding[]) => findings.some(item => item.status === "fail");
