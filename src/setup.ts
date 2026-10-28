import { resolve } from "node:path";
import { Effect } from "effect";
import { draftWorkspace } from "./draft";
import { doctor, type Finding } from "./doctor";
import { scannedLanguages } from "./languages";
import { checkAndRecord, staleOf, staleText } from "./stale";

/**
 * `pathlight setup`: the first run, in one command an agent (or a person) can run and read. It looks at the machine and the workspace (the same
 * checks as `pathlight doctor`), says what it would write, and writes only with `--yes`. It does one thing that writes: draw a first model from the
 * code when there is none (`pathlight draft`, which never rewrites a model somebody wrote). Wiring hooks and turning recording on stay with
 * `pathlight init`, because they change the person's settings and need their agreement; setup names that step and does not take it.
 */
const mark = (finding: Finding) => finding.status === "ok" ? "✓" : finding.status === "fail" ? "✗" : "·";

export const setup = Effect.fn("Setup.run")(function* (workspace: string, options: { yes: boolean }) {
  const root = resolve(workspace);
  const findings = yield* doctor(root);
  const get = (name: string) => findings.find(finding => finding.name === name);
  const modelOk = get("model")?.status === "ok", mappingOk = get("file mapping")?.status === "ok";
  const lines = [`pathlight setup · ${root}`, ""];
  for (const name of ["tmux", "on PATH", "model", "file mapping", "Claude Code"]) {
    const finding = get(name);
    if (!finding) continue;
    lines.push(`${mark(finding)} ${name.padEnd(13)} ${finding.detail}`);
    if (finding.fix && finding.status !== "ok" && name !== "model" && name !== "file mapping") lines.push(`    ${finding.fix}`);
  }
  lines.push("");

  let ready = modelOk && mappingOk;
  if (!modelOk && !mappingOk) {
    if (!options.yes) {
      lines.push("Nothing to look at yet. With --yes this would draw a first picture from the code's imports (no model in the loop) and write",
        "  pathlight.model.c4, pathlight.activity.json and likec4.config.json in .pathlight/. It never rewrites a model you wrote.");
    } else {
      const made = yield* draftWorkspace(root);
      lines.push(`Drew ${made.elements} elements and ${made.relationships} relationships from the imports (${made.mappings} file mappings).`,
        "Wrote pathlight.model.c4, pathlight.activity.json and likec4.config.json in .pathlight/. It shows what the code does, not what it is for: have the agent name the boxes (pathlight brief lists what it needs, pathlight name saves it; /pathlight does both), or press m on one box.",
        ...(made.unread ? [`Not read: ${made.unread}. The scan reads ${scannedLanguages}, so their boxes are drawn but no arrow to or from them is.`] : []));
      ready = true;
    }
  } else if (modelOk && !mappingOk) {
    lines.push("There is a model but no file mapping, so the viewer cannot light up what the agent touches. Run `pathlight init` (it maps boxes to files by name, wires the hooks and turns recording on) and review .pathlight/pathlight.activity.json.");
  } else if (!modelOk && mappingOk) {
    lines.push("There is a file mapping but no model it can load. Write the model, or remove .pathlight/pathlight.activity.json and run this again.");
  } else lines.push("A model and a file mapping are already here; nothing to write.");

  if (ready) {
    const check = yield* checkAndRecord(root).pipe(Effect.option);
    if (check._tag === "Some") lines.push(`Checked against the code: ${staleText(staleOf(check.value)) ?? "the picture and the code agree"}.`);
    else lines.push("The model could not be checked: run `pathlight check --workspace .` to see why.");
    lines.push("", "Open it beside the conversation: /pathlight:open in Claude Code, /pathlight-open in OpenCode, or `pathlight open --workspace .` in a tmux pane.");
  } else if (!options.yes && !modelOk && !mappingOk) lines.push("", "Run `pathlight setup --yes` to do this.");
  return `${lines.join("\n")}\n`;
});
