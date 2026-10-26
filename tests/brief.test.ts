import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { briefOf, formatBrief, nameBoxes, select } from "../src/brief";
import { draftWorkspace } from "../src/draft";
import { overlayIn, run } from "./effects";

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo" }),
  "src/index.ts": `import { start } from "./session";\nexport const main = start;\n`,
  "src/session.ts": `import { db } from "./database/db";\nexport const start = () => db;\n`,
  "src/session/run.ts": `import { db } from "../database/db";\nexport const run = db;\n`,
  "src/session/stop.ts": `export const stop = 1;\n`,
  "src/database/db.ts": `export const db = 1;\n`,
  "src/database/query.ts": `import { db } from "./db";\nexport const q = db;\n`,
  "src/database/index.ts": `export * from "./db";\n`,
  "benchmarks/bench.ts": `import { db } from "../src/database/db";\nexport const b = db;\n`,
};
const write = async (root: string) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);

test("a box lists every file it owns, so a folder and the loose file beside it read as one box, with what it imports and what imports it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-brief-"));
  try {
    await write(directory);
    await Effect.runPromise(draftWorkspace(directory));
    const boxes = await Effect.runPromise(briefOf(directory));
    const session = boxes.find(box => box.key === "src/session")!;
    expect(session.kind).toBe("component");
    expect(session.files.map(file => file.path).sort()).toEqual(["src/session.ts", "src/session/run.ts", "src/session/stop.ts"]);
    expect(session.imports.map(item => item.key)).toContain("src/database");
    expect(boxes.find(box => box.key === "src/database")!.importedBy.map(item => item.key)).toEqual(expect.arrayContaining(["src/session", "benchmarks"]));
    expect(boxes.some(box => box.key === "src/benchmarks")).toBe(false);
    // A workspace of one package is flat: its components are the top level, so there is no package box above them.
    expect(boxes.some(box => box.kind === "package")).toBe(false);
    expect(select(boxes, ["nope"]).missing).toEqual(["nope"]);
    const text = formatBrief(select(boxes, ["src/session"]).boxes, boxes);
    expect(text).toContain("## src/session  (component");
    expect(text).toContain("src/session.ts (");
    expect(text).toContain("imports from: src/database");
    expect(text).toContain("defines: start");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("names are saved as the agent's reading, never over a person's, refused for a key that is no box, and the map is redrawn once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-name-"));
  try {
    await write(directory);
    await Effect.runPromise(draftWorkspace(directory));
    await writeFile(overlayIn(directory), JSON.stringify({ version: 1, elements: { "src/database": { title: "Store", note: "Mine", by: "human" } } }));
    const result = await Effect.runPromise(nameBoxes(directory, [
      { key: "src/session", title: "Sessions", note: "Starts and stops one run of the app" },
      { key: "src/database", title: "Overwritten?", note: "No" },
      { key: "src/nowhere", note: "x" },
    ]));
    expect(result).toMatchObject({ saved: ["src/session"], kept: ["src/database"], unknown: ["src/nowhere"], rebuilt: true });
    const overlay = JSON.parse(await readFile(overlayIn(directory), "utf8")) as { elements: Record<string, { title?: string; note?: string; by?: string }> };
    expect(overlay.elements["src/session"]).toEqual({ title: "Sessions", note: "Starts and stops one run of the app", by: "agent" });
    expect(overlay.elements["src/database"]).toEqual({ title: "Store", note: "Mine", by: "human" });
    expect(await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8")).toContain("Sessions");
    // Saying the same again changes nothing.
    expect(await Effect.runPromise(nameBoxes(directory, [{ key: "src/session", title: "Sessions", note: "Starts and stops one run of the app" }]))).toMatchObject({ saved: [], unchanged: ["src/session"], rebuilt: false });
    // Too long, or a line break: refused before anything is written.
    await expect(Effect.runPromise(nameBoxes(directory, [{ key: "src/session", note: "x".repeat(301) }]))).rejects.toThrow("at most 300");
    await expect(Effect.runPromise(nameBoxes(directory, [{ key: "src/session", note: "two\nlines" }]))).rejects.toThrow("at most 300");
    expect(JSON.parse(await readFile(overlayIn(directory), "utf8")).elements["src/session"].note).toBe("Starts and stops one run of the app");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("pathlight brief prints a box and pathlight name takes a JSON array on standard input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-name-cli-"));
  try {
    await write(directory);
    await Effect.runPromise(draftWorkspace(directory));
    expect(await cli("brief", "src/database", "--workspace", directory)).toContain("imported by: ");
    await expect(cli("brief", "src/nope", "--workspace", directory)).rejects.toThrow("No box has the key");
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "name", "--from", "-", "--workspace", directory], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify([{ key: "src/database", title: "Database", note: "Holds the app's data" }, { key: "nowhere", note: "x" }]));
    await child.stdin.end();
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out).toContain("Saved 1 name");
    expect(out).toContain("No box has these keys");
    expect(await cli("brief", "src/database", "--workspace", directory)).toContain("current: “Database”");
    await expect(cli("name", "--workspace", directory)).rejects.toThrow("Use pathlight name KEY");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

test("the brief opens with what the project says about itself, only when it covers the whole map", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-brief-context-"));
  try {
    await write(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "demo", description: "A demo that sells parcels" }));
    await writeFile(join(directory, "README.md"), "# Demo\n\nSells parcels to people.\n");
    await mkdir(join(directory, "docs"), { recursive: true });
    await writeFile(join(directory, "docs", "design.md"), "# design\n");
    await Effect.runPromise(draftWorkspace(directory));
    const whole = await cli("brief", "--workspace", directory);
    expect(whole).toContain("# About the project");
    expect(whole).toContain("description: A demo that sells parcels");
    expect(whole).toContain("documents: docs/design.md");
    expect(whole).toContain("  Sells parcels to people.");
    expect(await cli("brief", "src/session", "--workspace", directory)).not.toContain("About the project");
    expect(JSON.parse(await cli("brief", "--json", "--workspace", directory))).toBeInstanceOf(Array);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("brief --changed lists only boxes whose files changed since they were named, and never one a person named", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-brief-changed-"));
  try {
    await write(directory);
    await Effect.runPromise(draftWorkspace(directory));
    const all = await Effect.runPromise(briefOf(directory));
    const keys = all.map(box => box.key);
    expect(await cli("brief", "--changed", "--workspace", directory)).toContain("Nothing records when these boxes were named");
    // Name everything but one box a person pinned.
    await writeFile(join(directory, ".pathlight", "pathlight.overlay.json"), JSON.stringify({ version: 1, elements: { "src/database": { title: "Data", note: "By hand.", by: "human" } } }));
    const entries = keys.filter(key => key !== "src/database").map(key => ({ key, title: `T ${key}`.slice(0, 60), note: "Named." }));
    await writeFile(join(directory, "names.json"), JSON.stringify(entries));
    await cli("name", "--workspace", directory, "--from", join(directory, "names.json"));
    expect(await cli("brief", "--changed", "--workspace", directory)).toContain("Every box is named and its files are unchanged since.");
    await writeFile(join(directory, "src/session/stop.ts"), "export const stop = 2;\n");
    const after = await cli("brief", "--changed", "--workspace", directory);
    expect(after).toContain("## src/session  (component");
    expect(after).not.toContain("## src/database ");
    expect(after).not.toContain("## benchmarks ");
    // A person-named box is not offered even when its files change.
    await writeFile(join(directory, "src/database/db.ts"), "export const db = 2;\n");
    expect(await cli("brief", "--changed", "--workspace", directory)).not.toContain("## src/database ");
    expect(await cli("brief", "--changed", "src/session", "--workspace", directory).catch((error: Error) => error.message)).toContain("takes no keys");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

test("the brief lists where the code can start: what package.json declares, then files nothing imports, each with its box", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-brief-entry-"));
  try {
    await write(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "demo", scripts: { serve: "bun run src/index.ts --port 1", test: "bun test src/session/stop.ts" }, bin: { demo: "./src/session/run.ts" } }));
    await writeFile(join(directory, "src/orphan.test.ts"), `import { db } from "./database/db";\nexport const t = db;\n`);
    await Effect.runPromise(draftWorkspace(directory));
    const text = await cli("brief", "--workspace", directory);
    expect(text).toContain("# Where the code can be started");
    expect(text).toContain("src/index.ts [.#loose] — script “serve”");
    expect(text).toContain("src/session/run.ts [src/session] — bin “demo”");
    expect(text).not.toContain("script “test”");
    expect(text).not.toContain("orphan.test.ts");
    expect(text).toContain("benchmarks/bench.ts [benchmarks] — no other file imports it");
    expect(await cli("brief", "src/session", "--workspace", directory)).not.toContain("Where the code can be started");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
