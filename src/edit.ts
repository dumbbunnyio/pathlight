import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { draftWorkspace, keysPath, Overlay, overlayFile } from "./draft";
import { failure, io, json } from "./effects";

/** Each generated element's overlay key, written by `pathlight draft` so the viewer can tell the overlay which element a box is. */
export const readKeys = Effect.fn("Edit.keys")(function* (workspace: string) {
  const text = yield* io("Edit.keys", () => readFile(join(resolve(workspace), keysPath), "utf8")).pipe(Effect.option);
  if (text._tag === "None") return new Map<string, string>();
  const parsed = yield* json(text.value).pipe(Effect.option);
  const keys = parsed._tag === "Some" && parsed.value && typeof parsed.value === "object" ? (parsed.value as { keys?: unknown }).keys : undefined;
  return new Map(Object.entries(keys && typeof keys === "object" ? keys as Record<string, unknown> : {}).flatMap(([id, key]) => typeof key === "string" ? [[id, key] as const] : []));
});

const readOverlay = Effect.fn("Edit.overlay")(function* (workspace: string) {
  const text = yield* io("Edit.overlay", () => readFile(join(resolve(workspace), overlayFile), "utf8")).pipe(Effect.option);
  if (text._tag === "None") return { version: 1, elements: {} } as Overlay;
  return yield* Schema.decodeUnknownEffect(Overlay, { onExcessProperty: "error" })(yield* json(text.value));
});

/** What the overlay already says about a key, to prefill the form. */
export const readEntry = Effect.fn("Edit.entry")(function* (workspace: string, key: string) {
  return (yield* readOverlay(workspace)).elements[key];
});

/**
 * Pins a name and note for one element as the person's own decision (`by: "human"`), then regenerates the draft so the viewer picks it up.
 * A name left as the generated one is not stored, so the element keeps following its folder. Both empty removes the entry.
 */
export const saveElement = Effect.fn("Edit.save")(function* (workspace: string, key: string, entry: { title: string; note: string }, generated: string) {
  const root = resolve(workspace);
  const overlay = yield* readOverlay(root);
  const title = entry.title.trim(), note = entry.note.trim();
  const { [key]: _removed, ...others } = overlay.elements;
  const next = { ...overlay, elements: title || note ? { ...others, [key]: { ...(title && title !== generated ? { title } : {}), ...(note ? { note } : {}), by: "human" as const } } : others };
  const valid = yield* Schema.decodeUnknownEffect(Overlay, { onExcessProperty: "error" })(next).pipe(Effect.mapError(() => failure("Edit.invalid", "A name is at most 60 characters and a note at most 300, with no line breaks.")));
  yield* io("Edit.write", async () => {
    await mkdir(root, { recursive: true });
    const temporary = `${join(root, overlayFile)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`);
    await rename(temporary, join(root, overlayFile));
  });
  return yield* draftWorkspace(root);
});
