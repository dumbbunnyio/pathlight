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
