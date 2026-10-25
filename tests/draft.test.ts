import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { checkWorkspace } from "../src/check";
import { listViews } from "../src/catalog";
import { analyse, crowdedAbove, draftOf, draftWorkspace, generatedMarker, likec4Keywords, loops, viewCap, witness } from "../src/draft";
import { readdir } from "node:fs/promises";
import { mappingIn, overlayIn } from "./effects";

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

const monorepo = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
  "packages/core/src/session.ts": `import { db } from "./database/db";\nimport { shared } from "@acme/schema";\nexport const session = db + shared;\n`,
  "packages/core/src/session/run.ts": `import { db } from "../database/db";\nexport const run = db;\n`,
  "packages/core/src/database/db.ts": `export const db = 1;\n`,
  "packages/core/src/database/query.ts": `export const q = 1;\n`,
  "packages/core/src/bus.ts": `import { db } from "./database/db";\nexport const bus = db;\n`,
  "packages/core/src/style/rules.ts": `export const rule = 1;\n`,
  "packages/core/test/session.test.ts": `import { session } from "../src/session";\nexport const t = session;\n`,
  "packages/schema/package.json": JSON.stringify({ name: "@acme/schema", main: "src/index.ts" }),
  "packages/schema/src/index.ts": `export const shared = 1;\n`,
};

/** The ids of the views written about packages, collections and listings: the per-component neighbourhoods (`*_near`) are checked separately. */
const overviews = (views: { id: unknown }[]) => views.map(view => String(view.id)).filter(id => !id.endsWith("_near")).sort();
const file = (path: string) => ({ path, language: "typescript" as const, lines: 1 });
const edge = (from: string, to: string) => ({ from, to, line: 1, kind: "import" as const, specifier: "x" });

test("the reserved words are LikeC4's own: every keyword in the installed grammar is on the list", async () => {
  const chunks = join("node_modules", "likec4", "dist", "chunks");
  let grammar = "";
  for (const entry of await readdir(chunks, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = await readFile(join(chunks, entry.name), "utf8");
    if (text.includes('"$type":"Keyword","value":"navigateTo"')) { grammar = text; break; }
  }
  expect(grammar.length).toBeGreaterThan(0);
  const installed = [...new Set([...grammar.matchAll(/"\$type":"Keyword","value":"([A-Za-z_][A-Za-z0-9_]*)"/g)].map(match => match[1]!))].sort();
  expect(installed.filter(word => !(likec4Keywords as readonly string[]).includes(word))).toEqual([]);
});

test("draftOf turns packages and folders into components, joins x.ts to x/, leaves tests out and counts imports between components", () => {
  const draft = draftOf(
    { files: ["packages/core/src/session.ts", "packages/core/src/session/run.ts", "packages/core/src/database/db.ts", "packages/core/src/bus.ts", "packages/core/src/style/rules.ts",
      "packages/core/test/session.test.ts", "packages/schema/src/index.ts"].map(file),
      imports: [
        edge("packages/core/src/session.ts", "packages/core/src/database/db.ts"),
        edge("packages/core/src/session/run.ts", "packages/core/src/database/db.ts"),
        edge("packages/core/src/bus.ts", "packages/core/src/database/db.ts"),
        edge("packages/core/src/session.ts", "packages/schema/src/index.ts"),
        edge("packages/core/src/session.ts", "packages/core/src/session/run.ts"),
        edge("packages/core/test/session.test.ts", "packages/core/src/session.ts"),
      ] },
    [{ directory: "", name: "root" }, { directory: "packages/core", name: "@acme/core" }, { directory: "packages/schema", name: "@acme/schema" }]);
  expect(draft.flat).toBe(false);
  expect(draft.ignored).toBe(1);
  expect(draft.ignore).toEqual(["**/test/**", "**/*.test.*"]);
  // Three folders with fewer than three files each share a collection; bus.ts alone is one ordinary component.
  expect(draft.packages.map(item => [item.id, item.components.map(entry => entry.id)])).toEqual([
    ["core", ["core.root", "core.small.database", "core.small.session", "core.small.style_"]], ["schema", ["schema.root"]],
  ]);
  expect(draft.packages[0]!.groups).toEqual([{ id: "core.small", key: "packages/core#small", title: "small folders", package: "core", kind: "small" }]);
  const core = draft.packages[0]!.components;
  // session.ts belongs with session/; bus.ts is a loose file; `style` is LikeC4 syntax so its id gets an underscore.
  expect(core.find(entry => entry.id === "core.small.session")!.files).toEqual(["packages/core/src/session.ts", "packages/core/src/session/run.ts"]);
  expect(core.find(entry => entry.id === "core.small.session")!.globs).toEqual(["packages/core/src/session/**", "packages/core/src/session.ts"]);
  expect(core.find(entry => entry.id === "core.root")!.globs).toEqual(["packages/core/src/bus.ts"]);
  expect(draft.relationships).toEqual([
    { from: "core.root", to: "core.small.database", imports: 1 }, { from: "core.small.session", to: "core.small.database", imports: 2 }, { from: "core.small.session", to: "schema.root", imports: 1 },
  ]);
});

test("draft writes a model LikeC4 accepts and `check` finds nothing wrong with, and the same code gives the same text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-"));
  try {
    await write(directory, monorepo);
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made).toMatchObject({ packages: 2, components: 5, collections: 1, relationships: 3, ignored: 1 });
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model.startsWith(generatedMarker)).toBe(true);
    const views = await Effect.runPromise(listViews(directory));
    expect(overviews(views.views)).toEqual(["core_components", "core_small_components", "index", "schema_components"]);
    // Every component with a connection has a neighbourhood view: core.root, the three small folders' connected ones, schema.root.
    expect(views.views.map(view => String(view.id)).filter(id => id.endsWith("_near")).sort()).toEqual(["core_root_near", "core_small_database_near", "core_small_session_near", "schema_root_near"]);
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, unsupported: 0, undeclared: 0 });
    // Rerunning replaces its own previous output with identical text.
    await Effect.runPromise(draftWorkspace(directory));
    expect(await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8")).toBe(model);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// 30 folders, each importing the next one twice over and the one after once: more lines than a view can show, so the weakest are hidden.
test("a view with too many connections hides the weakest tier, says so, and the model stays valid with every connection still in it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-thin-"));
  try {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "wide" }) };
    const name = (n: number) => `f${String(n).padStart(2, "0")}`;
    for (let n = 0; n < 30; n++) {
      const imports = (file: string, targets: number[]) => targets.filter(target => target < 30).map(target => `import "../${name(target)}/${file}";\n`).join("");
      files[`src/${name(n)}/a.ts`] = `${imports("a", [n + 1, n + 2])}export const a${n} = 1;\n`;
      files[`src/${name(n)}/b.ts`] = `${imports("b", [n + 1])}export const b${n} = 1;\n`;
      files[`src/${name(n)}/c.ts`] = `export const c${n} = 1;\n`;
    }
    await write(directory, files);
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made).toMatchObject({ packages: 0, components: 30, relationships: 57 });
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("exclude * -> * where tag is #lt2");
    expect(model).toContain("description 'Connections with fewer than 2 imports are hidden here.");
    expect(model.split("\n").filter(line => line.startsWith("  f") && line.includes(" -> ")).length).toBe(57);
    // 30 components do not fit one view: the overview keeps the strongest and `all_components` lists every one.
    expect(overviews((await Effect.runPromise(listViews(directory))).views)).toEqual(["all_components", "index"]);
    expect(model).toContain("exclude * where tag is #minor");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("collections: several small folders share one, many loose files are listed one by one, and fewer than that stay ordinary components", async () => {
  const paths = ["src/big/a.ts", "src/big/b.ts", "src/big/c.ts", "src/one/x.ts", "src/two/y.ts", "src/three/z.ts", "src/bus.ts", "src/agent.ts", "src/app.ts", "src/config.ts"];
  const draft = draftOf({ files: paths.map(file), imports: [edge("src/bus.ts", "src/big/a.ts"), edge("src/agent.ts", "src/one/x.ts"), edge("src/app.ts", "src/bus.ts")] }, [{ directory: "", name: "app" }]);
  expect(draft.flat).toBe(true);
  expect(draft.packages[0]!.groups.map(group => `${group.id}:${group.kind}`)).toEqual(["small:small", "loose:loose"]);
  expect(draft.packages[0]!.components.map(entry => `${entry.id}${entry.group ? ` in ${entry.group}` : ""}`)).toEqual([
    "big", "loose.agent_ in loose", "loose.app in loose", "loose.bus in loose", "loose.config in loose", "small.one in small", "small.three in small", "small.two in small",
  ]);
  expect(draft.relationships.map(item => `${item.from} -> ${item.to}`)).toEqual(["loose.agent_ -> small.one", "loose.app -> loose.bus", "loose.bus -> big"]);
  // Two small folders are not worth a collection; three loose files are not either.
  const few = draftOf({ files: ["src/big/a.ts", "src/big/b.ts", "src/big/c.ts", "src/one/x.ts", "src/two/y.ts", "src/bus.ts", "src/agent.ts", "src/app.ts"].map(file), imports: [] }, [{ directory: "", name: "app" }]);
  expect(few.packages[0]!.groups).toEqual([]);
  expect(few.packages[0]!.components.map(entry => entry.id)).toEqual(["big", "one", "root", "two"]);
});

test("a workspace with collections gets a drill-down view for each, and `check` still maps every file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-collections-"));
  try {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "app" }) };
    for (const folder of ["big", "one", "two", "three"]) for (const n of folder === "big" ? [1, 2, 3] : [1]) files[`src/${folder}/f${n}.ts`] = `export const ${folder}${n} = 1;\n`;
    for (const loose of ["bus", "agent", "app", "config"]) files[`src/${loose}.ts`] = loose === "bus" ? `import { big1 } from "./big/f1";\nexport const bus = big1;\n` : `export const ${loose} = 1;\n`;
    await write(directory, files);
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made).toMatchObject({ collections: 2, components: 8 });
    expect(overviews((await Effect.runPromise(listViews(directory))).views)).toEqual(["index", "loose_components", "small_components"]);
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, unsupported: 0, undeclared: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a root package whose folder also holds other packages claims only its own files, so no file has two owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-nested-"));
  try {
    await write(directory, {
      "package.json": JSON.stringify({ name: "root" }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/a/src/one.ts": `import { orphan } from "../../orphan/x";\nexport const one = orphan;\n`,
      "packages/a/src/two.ts": `export const two = 1;\n`, "packages/a/src/three.ts": `export const three = 1;\n`,
      // No package.json of its own: it belongs to the root package, but sits under a folder full of other packages.
      "packages/orphan/x.ts": `export const orphan = 1;\n`, "packages/orphan/y.ts": `export const y = 1;\n`, "packages/orphan/z.ts": `export const z = 1;\n`,
    });
    await Effect.runPromise(draftWorkspace(directory));
    const mapping = JSON.parse(await readFile(mappingIn(directory), "utf8")) as { mappings: { glob: string; element: string }[] };
    expect(mapping.mappings.some(item => item.glob === "packages/**")).toBe(false);
    const owners = (path: string) => mapping.mappings.filter(item => new Bun.Glob(item.glob).match(path)).map(item => item.element);
    for (const path of ["packages/a/src/one.ts", "packages/orphan/x.ts", "packages/orphan/z.ts"]) expect([path, owners(path).length]).toEqual([path, 1]);
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, unsupported: 0, undeclared: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("imports of stylesheets count, and a test inside a claimed folder is not evidence either way", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-assets-"));
  try {
    await write(directory, {
      "package.json": JSON.stringify({ name: "app" }),
      "src/ui/a.ts": `import "../styles/theme.css";\nexport const a = 1;\n`, "src/ui/b.ts": "export const b = 1;\n", "src/ui/c.ts": "export const c = 1;\n",
      "src/styles/index.ts": "export const s = 1;\n", "src/styles/x.ts": "export const x = 1;\n", "src/styles/y.ts": "export const y = 1;\n", "src/styles/theme.css": "body {}\n",
      "src/data/d.ts": "export const d = 1;\n", "src/data/e.ts": "export const e = 1;\n", "src/data/f.ts": "export const f = 1;\n",
      // This test sits in src/ui, which the folder glob claims; it reaches into data, which the real code in ui never does.
      "src/ui/a.test.ts": `import { d } from "../data/d";\nexport const t = d;\n`,
    });
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("ui -> styles '1 import'");
    expect(model).not.toContain("ui -> data");
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, unsupported: 0, undeclared: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("loops finds nodes that can all reach each other, and only those", () => {
  expect(loops(["a", "b", "c", "d", "e"], [["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"], ["d", "e"]])).toEqual([["a", "b", "c"]]);
  expect(loops(["a", "b"], [["a", "b"]])).toEqual([]);
  expect(loops(["a", "b", "c", "d"], [["a", "b"], ["b", "a"], ["c", "d"], ["d", "c"], ["a", "c"]])).toEqual([["a", "b"], ["c", "d"]]);
  expect(loops(["a"], [["a", "a"]])).toEqual([]);
});

test("witness keeps the shortest way back to each member of a loop, and the strongest lines when even that is too many", () => {
  const edge = (from: string, to: string, imports = 1) => ({ from, to, imports });
  // a -> b -> c -> a is the only loop; d hangs off it and is not in it.
  const loop = witness(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d")]);
  expect(loop.complete).toBe(true);
  expect(loop.edges.map(item => `${item.from}->${item.to}`)).toEqual(["a->b", "b->c", "c->a"]);
  // A two-step loop is preferred over a longer one through the same node.
  const short = witness(["a", "b", "c"], [edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "a")]);
  expect(short.edges.map(item => `${item.from}->${item.to}`)).toEqual(["a->b", "b->a", "b->c", "c->a"]);
  // Everything imports everything: 20 members have 380 lines among them, but a witness is at most two per member.
  const names = Array.from({ length: 20 }, (_, n) => `n${String(n).padStart(2, "0")}`);
  const dense = witness(names, names.flatMap(from => names.filter(to => to !== from).map(to => edge(from, to))));
  expect(dense.edges.length).toBeLessThanOrEqual(40);
  expect(dense.complete).toBe(true);
  const limited = witness(names, names.flatMap(from => names.filter(to => to !== from).map(to => edge(from, to, from < to ? 5 : 1))), 10);
  expect(limited.edges.length).toBe(10);
  expect(limited.complete).toBe(false);
});

test("analyse keeps the strongest components in an overview and leaves the weakest beyond the cap to the listing, with ids unchanged", () => {
  const count = crowdedAbove + 6;
  const names = Array.from({ length: count }, (_, n) => `m${String(n).padStart(2, "0")}`);
  const paths = names.flatMap(name => ["a", "b", "c"].map(leaf => `src/${name}/${leaf}.ts`));
  // m00 is imported by everyone, so it is the strongest; the last ones connect to nothing.
  const imports = names.slice(1, 12).map(name => edge(`src/${name}/a.ts`, "src/m00/a.ts"));
  const draft = draftOf({ files: paths.map(file), imports }, [{ directory: "", name: "wide" }]);
  const result = analyse(draft);
  expect(draft.packages[0]!.components.length).toBe(count);
  // Nothing connects out of this one package, so the room is the budget less the box drawn around the package.
  expect(result.minor.size).toBe(count - (crowdedAbove - 1));
  expect(result.minor.has("m00")).toBe(false);
  expect(result.minor.has(`m${String(count - 1).padStart(2, "0")}`)).toBe(true);
  expect(result.weight.get("m00")).toBe(11);
});

test("analyse does not let tooling outrank the product: a benchmarks folder importing everything moves out of the overview first", () => {
  const count = crowdedAbove + 2;
  const names = Array.from({ length: count }, (_, n) => `m${String(n).padStart(2, "0")}`);
  const paths = [...names, "benchmarks"].flatMap(name => ["a", "b", "c"].map(leaf => `src/${name}/${leaf}.ts`));
  const imports = [...names.slice(1, 4).map(name => edge(`src/${name}/a.ts`, "src/m00/a.ts")), ...names.map(name => edge("src/benchmarks/a.ts", `src/${name}/a.ts`))];
  const result = analyse(draftOf({ files: paths.map(file), imports }, [{ directory: "", name: "wide" }]));
  expect(result.minor.has("benchmarks")).toBe(true);
  // Only the three real imports count; the 22 the benchmarks make say nothing about what m00 is used for.
  expect(result.weight.get("m00")).toBe(3);
  expect(result.weight.get("benchmarks") ?? 0).toBe(0);
});

test("a workspace with an import loop gets a cycles view naming its size, and its neighbourhood views, listings and cycle reports are declared entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-cycles-"));
  try {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "loopy" }) };
    for (const folder of ["a", "b", "c", "d"]) for (const n of [1, 2, 3]) files[`src/${folder}/f${n}.ts`] = n === 1 && folder !== "d" ? `import "../${folder === "a" ? "b" : folder === "b" ? "c" : "a"}/f2";\n` : `export const ${folder}${n} = 1;\n`;
    files["src/d/f1.ts"] = `import "../a/f2";\n`;
    await write(directory, files);
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("view cycles {");
    expect(model).toContain("3 in one loop.");
    const config = JSON.parse(await readFile(mappingIn(directory), "utf8")) as { entries?: string[] };
    expect(config.entries).toEqual(["cycles"]);
    const views = await Effect.runPromise(listViews(directory));
    expect(overviews(views.views)).toEqual(["cycles", "index"]);
    // `cycles` is not linked from anywhere, and `check` does not count it as a second entry because the mapping declares it.
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.views.entries).toEqual(["index"]);
    expect(check.summary).toMatchObject({ undeclared: 0, unlinkedViews: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a loop of many components that all import each other is reported by its shortest loops, so the report can be laid out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-dense-"));
  try {
    const count = 14;
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "dense" }) };
    const name = (n: number) => `m${String(n).padStart(2, "0")}`;
    for (let n = 0; n < count; n++) {
      // Every folder imports every other: one strongly connected set with count * (count - 1) lines between its members.
      files[`src/${name(n)}/a.ts`] = Array.from({ length: count }, (_, other) => other).filter(other => other !== n).map(other => `import "../${name(other)}/b";\n`).join("") + "export const a = 1;\n";
      files[`src/${name(n)}/b.ts`] = "export const b = 1;\n"; files[`src/${name(n)}/c.ts`] = "export const c = 1;\n";
    }
    await write(directory, files);
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    const cycles = model.slice(model.indexOf("view cycles {"), model.indexOf("}", model.indexOf("view cycles {")) + 1);
    expect(cycles).toContain(`${count} in one loop.`);
    // 182 lines cannot be read or laid out. The model keeps all of them, and the report draws only the shortest loop through each member.
    const edges = model.split("\n").filter(line => / -> /.test(line) && line.startsWith("  m")).length;
    expect(edges).toBe(count * (count - 1));
    const drawn = cycles.split("\n").filter(line => line.trim().startsWith("include m")).length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThanOrEqual(count * 2);
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ undeclared: 0, unmatchedMappings: 0, unmappedFiles: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a hub with more neighbours than a view holds lists its strongest and says how many were left out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-hub-"));
  try {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "hubby" }), "src/hub/a.ts": "export const a = 1;\n", "src/hub/b.ts": "export const b = 1;\n", "src/hub/c.ts": "export const c = 1;\n" };
    const spokes = viewCap + 8;
    for (let n = 0; n < spokes; n++) for (const leaf of ["a", "b", "c"]) files[`src/s${String(n).padStart(2, "0")}/${leaf}.ts`] = leaf === "a" ? `import "../hub/a";\n` : `export const ${leaf} = 1;\n`;
    await write(directory, files);
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain(`the ${viewCap} strongest of ${spokes} neighbours.`);
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ undeclared: 0, unlinkedViews: 0, unmappedFiles: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("draft never rewrites a model you wrote, and writes elsewhere when asked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-draft-own-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "pathlight-draft-out-"));
  try {
    await write(directory, { ...monorepo, ".pathlight/architecture.c4": "specification { element component }\nmodel { a = component 'A' }\n" });
    await expect(Effect.runPromise(draftWorkspace(directory))).rejects.toThrow("never rewritten");
    expect(await readFile(join(directory, ".pathlight", "architecture.c4"), "utf8")).toContain("component 'A'");
    await Effect.runPromise(draftWorkspace(directory, { out: elsewhere }));
    expect(await readFile(join(elsewhere, "pathlight.model.c4"), "utf8")).toContain(generatedMarker);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
}, 60_000);

test("the overlay renames and annotates by what the code is, keeps applying when an id moves, and reports keys that match nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-overlay-"));
  try {
    await write(directory, monorepo);
    const overlay = {
      version: 1,
      elements: {
        "packages/core": { title: "Core", note: "Sessions and storage" },
        "packages/core/src/session": { title: "Sessions", note: "Runs a user's 'turn'" },
        "packages/gone/src/old": { title: "Old" },
      },
    };
    await writeFile(overlayIn(directory), JSON.stringify(overlay));
    const first = await Effect.runPromise(draftWorkspace(directory));
    expect(first).toMatchObject({ overlay: 2, unknown: ["packages/gone/src/old"] });
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("package 'Core'");
    expect(model).toContain("component 'Sessions'");
    expect(model).toContain("Sessions and storage · ");
    expect(model).toContain("Runs a user\\'s \\'turn\\' · ");
    expect(await Effect.runPromise(checkWorkspace(directory))).toMatchObject({ summary: { unmatchedMappings: 0, unmappedFiles: 0, undeclared: 0 } });

    // Two more files move `session` out of the small collection: its id changes, its name stays.
    await write(directory, { "packages/core/src/session/a.ts": "export const a = 1;\n", "packages/core/src/session/b.ts": "export const b = 1;\n" });
    await Effect.runPromise(draftWorkspace(directory));
    const after = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(after).not.toContain("small.session");
    expect(after).toContain("session = component 'Sessions'");
    // The overlay is never rewritten by a draft.
    expect(JSON.parse(await readFile(overlayIn(directory), "utf8"))).toEqual(overlay);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid overlay stops the draft instead of being half applied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-overlay-"));
  try {
    await write(directory, monorepo);
    for (const bad of [
      { version: 1, elements: { "packages/core": { title: "" } } },
      { version: 1, elements: { "packages/core": { title: "ok", id: "renamed" } } },
      { version: 1, elements: { "packages/core": { note: "line\nbreak" } } },
      { version: 2, elements: {} },
    ]) {
      await writeFile(overlayIn(directory), JSON.stringify(bad));
      await expect(Effect.runPromise(draftWorkspace(directory))).rejects.toBeDefined();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const withOverlay = async (files: Record<string, string>, overlay: unknown) => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-structure-"));
  await write(directory, files);
  await writeFile(overlayIn(directory), JSON.stringify(overlay));
  return directory;
};

test("an overlay merge makes several folders one top-level component, and the model still agrees with the code", async () => {
  const directory = await withOverlay(monorepo, { version: 1, elements: {}, merges: [{ title: "Data store", keys: ["packages/core/src/database", "packages/core/src/style"], by: "human" }] });
  try {
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made.problems).toEqual([]);
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("data_store = component 'Data store'");
    expect(model).not.toContain("= component 'database'");
    const config = JSON.parse(await readFile(mappingIn(directory), "utf8")) as { mappings: { glob: string; element: string }[] };
    expect(config.mappings.filter(item => item.element === "core.data_store").map(item => item.glob).sort()).toEqual(["packages/core/src/database/**", "packages/core/src/style/**"]);
    // session imports database: the arrow now ends at the merged component.
    expect(model).toContain("core.session -> core.data_store");
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, unsupported: 0, undeclared: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an overlay split gives each subfolder its own component and every file exactly one owner", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "solo" }),
    "src/big/a/one.ts": "export const one = 1;\n", "src/big/a/two.ts": "export const two = 1;\n", "src/big/a/three.ts": "export const three = 1;\n",
    "src/big/b/four.ts": "import { one } from '../a/one';\nexport const four = one;\n", "src/big/b/five.ts": "export const five = 1;\n", "src/big/b/six.ts": "export const six = 1;\n",
    "src/big/top.ts": "import { four } from './b/four';\nexport const top = four;\n",
    "src/other/x.ts": "import { top } from '../big/top';\nexport const x = top;\n", "src/other/y.ts": "export const y = 1;\n", "src/other/z.ts": "export const z = 1;\n",
  };
  const directory = await withOverlay(files, { version: 1, elements: {}, splits: [{ key: "src/big", by: "agent" }] });
  try {
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made.problems).toEqual([]);
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    for (const title of ["big/a", "big/b", "big (files)"]) expect(model).toContain(`component '${title}'`);
    const config = JSON.parse(await readFile(mappingIn(directory), "utf8")) as { mappings: { glob: string; element: string }[] };
    expect(config.mappings.map(item => item.element)).toContain("big_b");
    for (const path of Object.keys(files).filter(name => name.startsWith("src/"))) {
      const owners = new Set(config.mappings.filter(item => new Bun.Glob(item.glob).match(path)).map(item => item.element));
      expect([path, owners.size]).toEqual([path, 1]);
    }
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, unsupported: 0, undeclared: 0 });
    // The imports across the split are real relationships now: b uses a, the loose file uses b.
    expect(model).toContain("big_b -> big_a");
    expect(model).toContain("big_files -> big_b");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a pinned relationship title labels an arrow imports support, and the count moves to its description", async () => {
  const directory = await withOverlay(monorepo, { version: 1, elements: {}, relationships: [{ from: "packages/core#loose", to: "packages/core/src/database", title: "reads and writes rows", by: "human" }] });
  try {
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made.problems).toEqual([]);
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toMatch(/core\.root -> core\.small\.database 'reads and writes rows' \{\n    #lt2[^\n]*\n    description '1 import'/);
    expect((await Effect.runPromise(checkWorkspace(directory))).summary).toMatchObject({ unsupported: 0, undeclared: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("overlay entries that contradict the code are skipped and reported, never drawn", async () => {
  const directory = await withOverlay(monorepo, { version: 1, elements: {},
    merges: [{ title: "Ghosts", keys: ["packages/core/src/database", "packages/core/src/nowhere"] }, { title: "Once", keys: ["packages/core/src/database", "packages/core/src/style"] }, { title: "Twice", keys: ["packages/core/src/style", "packages/core/src/database"] }],
    splits: [{ key: "packages/core/src/session" }, { key: "packages/core/src/missing" }],
    relationships: [{ from: "packages/core/src/style", to: "packages/core/src/database", title: "invented" }, { from: "packages/core/src/database", to: "packages/ghost", title: "nope" }] });
  try {
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made.problems.filter(text => text.startsWith("merge 'Ghosts'")).length).toBe(1);
    expect(made.problems.filter(text => text.startsWith("merge 'Twice'")).length).toBe(1);
    expect(made.problems.filter(text => text.startsWith("merge 'Once'")).length).toBe(0);
    expect(made.problems.some(text => text.startsWith("split 'packages/core/src/missing'"))).toBe(true);
    expect(made.problems.some(text => text.startsWith("split 'packages/core/src/session'") && text.includes("no subfolders"))).toBe(true);
    expect(made.problems.some(text => text.includes("no import runs from the first to the second"))).toBe(true);
    expect(made.problems.some(text => text.includes("is not a component of the draft"))).toBe(true);
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).not.toContain("invented");
    expect(model).not.toContain("Ghosts");
    expect(model).not.toContain("Twice");
    expect(model).toContain("component 'Once'");
    expect((await Effect.runPromise(checkWorkspace(directory))).summary).toMatchObject({ unmatchedMappings: 0, unmappedFiles: 0, undeclared: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("draft reports a human pin that differs from the last commit, and says nothing about agent entries", async () => {
  const pinned = { version: 1, elements: {}, merges: [{ title: "Data store", keys: ["packages/core/src/database", "packages/core/src/style"], by: "human" }], splits: [{ key: "packages/core/src/session", by: "agent" }] };
  const directory = await withOverlay(monorepo, pinned);
  const git = (...args: string[]) => Effect.runPromise(Effect.promise(async () => { const child = Bun.spawn(["git", "-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdout: "ignore", stderr: "ignore" }); await child.exited; }));
  try {
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "pins");
    expect((await Effect.runPromise(draftWorkspace(directory))).pins).toEqual([]);
    // The agent's entry can change freely; the human one cannot be altered or dropped unnoticed.
    await writeFile(overlayIn(directory), JSON.stringify({ ...pinned, splits: [] }));
    expect((await Effect.runPromise(draftWorkspace(directory))).pins).toEqual([]);
    await writeFile(overlayIn(directory), JSON.stringify({ ...pinned, merges: [{ title: "Data store", keys: ["packages/core/src/database", "packages/core/src/style"] }] }));
    expect((await Effect.runPromise(draftWorkspace(directory))).pins).toEqual(["merge 'Data store' (pinned by a human) differs from the last commit or is gone"]);
    await writeFile(overlayIn(directory), JSON.stringify({ version: 1, elements: {} }));
    expect((await Effect.runPromise(draftWorkspace(directory))).pins.length).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
