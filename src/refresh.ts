import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { readActivityConfig } from "./activity";
import { checkAndRecord } from "./stale";
import { diffWorkspace, recordDiff } from "./diff";
import { draftWorkspace, generatedMarker, hasFilesIn } from "./draft";
import { readKeys, readOverlay } from "./edit";
import { io, json } from "./effects";
import { homeOf, mappingPath, modelFile } from "./layout";
import { readPlan, setPlan } from "./plan";
import { isUnscannedSource, listFiles, scanWorkspace } from "./scan";

/**
 * The end of an agent's turn (Phase 6): one scan, then what `check` and `diff` record for the viewer, and between them, on a map Pathlight drew, a redraw
 * when the code has files no box claims, a planned box that now has files, or a box whose files are gone. A redraw keeps every name (the overlay is
 * keyed by path), never writes a model that would lose an id a journey names, and writes nothing when nothing would change. A model a person wrote is
 * never touched. The Claude Stop hook and OpenCode's end of a run call it.
 */

const statePath = (root: string, name: string) => join(root, ".cache", "pathlight", name);

/** Whether this workspace keeps its drawn map current, as the person answered once (`pathlight config set redraw`). Unset is on for a drawn map. */
export const Settings = Schema.Struct({ version: Schema.Literal(1), redraw: Schema.optionalKey(Schema.Literals(["on", "off"])) });
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const readSettings = (workspace: string) => Effect.gen(function* () {
  const root = yield* io("Refresh.root", () => realpath(workspace));
  const text = yield* io("Refresh.settings", () => readFile(statePath(root, "settings.json"), "utf8"));
  return yield* Schema.decodeUnknownEffect(Settings, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : { version: 1 as const }));

export const saveRedraw = Effect.fn("Refresh.saveRedraw")(function* (workspace: string, value: "on" | "off") {
  const root = yield* io("Refresh.root", () => realpath(workspace));
  const next = { ...(yield* readSettings(root)), redraw: value };
  yield* io("Refresh.saveSettings", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${statePath(root, "settings.json")}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`);
    await rename(temporary, statePath(root, "settings.json"));
  });
});

/** What the last refresh did, for `check` and the end-of-turn request: the boxes it added (by id and key) and, when it held back, why. */
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
export const Refreshed = Schema.Struct({
  version: Schema.Literal(1), time: Schema.Number,
  redrew: Schema.Boolean,
  added: Schema.Array(Schema.Struct({ id: Name, key: Name })).check(Schema.isMaxLength(4096)),
  /** New boxes with no name yet (a folder's own name), by key, at most `namingCap`: what the end of the turn asks the agent to have named. */
  unnamed: Schema.optionalKey(Schema.Array(Name).check(Schema.isMaxLength(64))),
  /** New boxes past the cap, asked about at the next end of a turn. */
  waiting: Schema.optionalKey(Schema.Array(Name).check(Schema.isMaxLength(4096))),
  /** A redraw was needed and not written: it would remove `element`, which the journey `journey` names. */
  blocked: Schema.optionalKey(Schema.Struct({ element: Name, journey: Name })),
});
export interface Refreshed extends Schema.Schema.Type<typeof Refreshed> {}

export const readRefreshed = (workspace: string) => Effect.gen(function* () {
  const root = yield* io("Refresh.root", () => realpath(workspace));
  const text = yield* io("Refresh.read", () => readFile(statePath(root, "refresh.json"), "utf8"));
  return yield* Schema.decodeUnknownEffect(Refreshed, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));

const writeRefreshed = (root: string, value: Refreshed) => io("Refresh.write", async () => {
  await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
  const temporary = `${statePath(root, "refresh.json")}.${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, statePath(root, "refresh.json"));
}).pipe(Effect.ignore);

/** At most this many new boxes are named per turn; the rest wait for the next turn or `pathlight brief --changed`. */
export const namingCap = 6;

/** The one line the end of a turn sends the agent when it drew boxes nobody has named: hand them to the namer, once. */
export const namingRequest = (keys: readonly string[], waiting = 0) => {
  const list = keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
  return `Pathlight drew ${keys.length === 1 ? "a new box" : `${keys.length} new boxes`} on the map, ${list}, named only by ${keys.length === 1 ? "its folder" : "their folders"}. `
    + `Hand ${keys.length === 1 ? "it" : "them"} to the pathlight-namer subagent with ${keys.length === 1 ? "this key" : "these keys"} (${keys.join(" ")}), then end your turn with one line on what you named.`
    + (waiting ? ` ${waiting} more are asked about at the end of the next turn.` : "");
};

export interface Refresh {
  /** No mapping: the workspace does not use Pathlight, and nothing ran. */
  mapped: boolean;
  /** The map was drawn by `pathlight draft` (a model a person wrote is never redrawn). */
  drawn: boolean;
  redraw: "on" | "off";
  /** Why a redraw was due, or nothing. */
  due: string[];
  redrew: boolean;
  added: { id: string; key: string }[];
  blocked?: { element: string; journey: string };
  /** The new boxes to name this turn (at most `namingCap`) and how many more wait; `request` is the one line the agent is sent. */
  unnamed: string[];
  waiting: number;
  request?: string;
  check?: { unmapped: number; unsupported: number; undeclared: number };
  diff?: { relationships: number; undeclared: number };
}

export const refreshWorkspace = Effect.fn("Refresh.workspace")(function* (workspace: string) {
  const root = yield* io("Refresh.root", () => realpath(workspace));
  const mapped = yield* io("Refresh.mapping", () => readFile(mappingPath(root), "utf8")).pipe(Effect.option);
  if (mapped._tag === "None") return { mapped: false, drawn: false, redraw: "off", due: [], redrew: false, added: [], unnamed: [], waiting: 0 } as Refresh;
  const scan = yield* scanWorkspace(root);
  const { paths } = yield* listFiles(root);
  const given = { scan, paths };
  const model = yield* io("Refresh.model", () => readFile(join(homeOf(root), modelFile), "utf8")).pipe(Effect.option);
  const drawn = model._tag === "Some" && model.value.startsWith(generatedMarker);
  const redraw = (yield* readSettings(root)).redraw ?? (drawn ? "on" : "off");

  let check = yield* checkAndRecord(root, given).pipe(Effect.option);
  const due: string[] = [];
  if (drawn && redraw === "on") {
    const overlay = yield* readOverlay(root).pipe(Effect.option);
    const present = [...scan.files.map(file => file.path), ...paths.filter(isUnscannedSource)];
    const built = overlay._tag === "Some" ? (overlay.value.planned ?? []).filter(item => hasFilesIn(present, item.path)) : [];
    if (check._tag === "None") due.push("the model could not be read");
    else {
      if (check.value.mappings.unmappedFiles.length) due.push(`${plural(check.value.mappings.unmappedFiles.length, "file")} no box claims`);
      if (check.value.mappings.unmatched.length) due.push(`${plural(check.value.mappings.unmatched.length, "mapping")} that match no file`);
    }
    if (built.length) due.push(`${built.length} planned ${built.length === 1 ? "box has" : "boxes have"} files`);
  }

  let redrew = false, blocked: Refresh["blocked"], added: Refresh["added"] = [];
  if (due.length) {
    const before = yield* readKeys(root);
    const made = yield* draftWorkspace(root, { given, keepJourneys: true });
    blocked = made.blocked;
    redrew = made.written;
    // With no keys from the last draw (a fresh clone, a cleaned cache) nothing says which boxes are new: none is announced or asked about.
    if (redrew && before.size) {
      const oldKeys = new Set(before.values());
      added = Object.entries(made.keys).filter(([, key]) => !oldKeys.has(key)).map(([id, key]) => ({ id, key })).sort((a, b) => a.id < b.id ? -1 : 1);
      // The agent's plan names ids; an id the redraw moved (a folder that left "small folders") follows its key, and one whose key is gone is dropped.
      const plan = yield* readPlan(root);
      if (plan) {
        const byKey = new Map(Object.entries(made.keys).map(([id, key]) => [key, id] as const));
        const next = [...new Set(plan.elements.flatMap(id => { const key = before.get(id); const moved = key === undefined ? (id in made.keys ? id : undefined) : byKey.get(key); return moved ? [moved] : []; }))];
        if (next.join() !== plan.elements.join()) yield* setPlan(root, next).pipe(Effect.ignore);
      }
    }
    if (redrew) check = yield* checkAndRecord(root, given).pipe(Effect.option);
  }
  // The boxes this redraw added that nobody has named: folders and files the code has (not a collection, not a resource), with no overlay entry. A
  // person's name is an entry, so a box a person named is never asked about.
  // Boxes past the last turn's cap come first, while they are still on the map and still unnamed.
  const last = yield* readRefreshed(root);
  const named = yield* readOverlay(root).pipe(Effect.option);
  const drawnKeys = new Set((yield* readKeys(root)).values());
  const isCode = (key: string) => !key.includes("#") && drawnKeys.has(key) && paths.some(path => path === key || path.startsWith(`${key}/`));
  const fresh = named._tag === "Some" ? [...new Set([...last?.waiting ?? [], ...added.map(item => item.key)])].filter(key => isCode(key) && !named.value.elements[key]) : [];
  const unnamed = fresh.slice(0, namingCap), later = fresh.slice(namingCap), waiting = later.length;
  yield* writeRefreshed(root, { version: 1, time: Date.now(), redrew, added, ...(unnamed.length ? { unnamed } : {}), ...(later.length ? { waiting: later } : {}), ...(blocked ? { blocked } : {}) });

  // The review of new dependencies, against the model as it now is. Not a git repository, or no commit yet: there is nothing to compare with.
  const config = yield* readActivityConfig(root).pipe(Effect.option);
  const diff = config._tag === "Some" ? yield* diffWorkspace(root, "HEAD", given).pipe(Effect.option) : undefined;
  if (diff?._tag === "Some") yield* recordDiff(root, diff.value);
  return {
    mapped: true, drawn, redraw, due, redrew, added, ...(blocked ? { blocked } : {}), unnamed, waiting, ...(unnamed.length ? { request: namingRequest(unnamed, waiting) } : {}),
    ...(check._tag === "Some" ? { check: { unmapped: check.value.mappings.unmappedFiles.length, unsupported: check.value.summary.unsupported, undeclared: check.value.summary.undeclared } } : {}),
    ...(diff?._tag === "Some" ? { diff: { relationships: diff.value.relationships.length, undeclared: diff.value.undeclared.length } } : {}),
  } as Refresh;
});

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function formatRefresh(result: Refresh) {
  if (!result.mapped) return "No .pathlight/pathlight.activity.json here: nothing to refresh.\n";
  const lines: string[] = [];
  if (result.check) lines.push(`Checked: ${plural(result.check.unmapped, "file")} not in the model, ${plural(result.check.undeclared, "import")} no relationship covers, ${plural(result.check.unsupported, "relationship")} no import backs.`);
  else lines.push("Checked: the model could not be read (pathlight check says why).");
  if (!result.drawn) lines.push("The map was written by a person, so it is never redrawn.");
  else if (result.redraw === "off") lines.push("Redraw is off for this workspace (pathlight config set redraw on --workspace . turns it on).");
  else if (result.blocked) lines.push(`Not redrawn: it would remove ${result.blocked.element}, which journey ${result.blocked.journey} uses. Rerun or remove that journey; the next turn then redraws.`);
  else if (result.redrew) lines.push(`Redrew the map (${result.due.join(", ")})${result.added.length ? `: new ${result.added.length === 1 ? "box" : "boxes"} ${result.added.map(item => item.key).join(", ")}` : ""}.`);
  else if (result.due.length) lines.push("The map already matches the code.");
  else lines.push("The map already matches the code: nothing to redraw.");
  if (result.diff) lines.push(`Since the last commit: ${plural(result.diff.relationships, "relationship")} changed, ${plural(result.diff.undeclared, "new import")} with no relationship.`);
  return `${lines.join("\n")}\n`;
}
