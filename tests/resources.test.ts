import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { checkWorkspace, formatCheck } from "../src/check";
import { listViews } from "../src/catalog";
import { draftWorkspace } from "../src/draft";
import { entryFor, resourceKinds, resourcesOf } from "../src/resources";
import table from "../src/resources/imports.json";
import { startWebServer } from "../src/web/server";
import type { Frame, Span } from "../src/web/wire";
import { run, selectView } from "./effects";

// Resources on the map (plan phase-r-resources.md, step 1): what the code talks to, from the packages its files import, through one table of data.

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const use = (from: string, name: string, kind = "import") => ({ from, package: name, line: 1, kind });

test("the table is data that holds together: every package leads to a defined resource of a known kind, once, and every engine has a name", () => {
  const seen = new Set<string>();
  for (const entry of table.packages as { match: string; resource: string; engine?: string }[]) {
    expect(seen.has(entry.match)).toBe(false);
    seen.add(entry.match);
    expect((table.resources as Record<string, unknown>)[entry.resource]).toBeDefined();
    if (entry.engine) expect((table.engines as Record<string, string>)[entry.engine]).toBeDefined();
  }
  for (const definition of Object.values(table.resources as Record<string, { kind: string }>)) expect(resourceKinds).toContain(definition.kind as never);
  // A Go module's packages and a version suffix lead to the module's entry; a longer name that only starts the same does not.
  expect(entryFor("github.com/jackc/pgx/v5/pgxpool")?.engine).toBe("postgresql");
  expect(entryFor("@aws-sdk/client-s3")?.resource).toBe("s3");
  expect(entryFor("@aws-sdk/client-s3control")).toBeUndefined();
  expect(entryFor("axios")).toBeUndefined();
});

test("a SQL database is named by its engine when the code names one, stays one box over two engines behind an ORM, and types and tests are no evidence", () => {
  const scope = (path: string) => path.startsWith("test/") ? undefined : path.split("/")[0]!;
  const found = resourcesOf([
    use("api/db.ts", "drizzle-orm"), use("api/client.ts", "bun:sqlite"), use("api/cache.ts", "ioredis"), use("api/cache.ts", "bullmq"),
    use("stats/db.ts", "drizzle-orm"), use("stats/client.ts", "@planetscale/database"),
    use("web/types.ts", "stripe", "type"), use("test/redis.ts", "ioredis-mock"), use("test/db.ts", "pg"),
    use("legacy/db.py", "sqlalchemy"), use("legacy/pg.py", "psycopg2"), use("legacy/lite.py", "sqlite3"),
  ], scope);
  expect(found.map(item => [item.id, item.title, item.kind, item.files.length])).toEqual([
    ["planetscale", "PlanetScale", "database", 2], ["redis", "Redis", "cache", 1], ["sql", "SQL database", "database", 3], ["sqlite", "SQLite", "database", 2],
  ]);
  // The ORM's package and each driver's package lead to the same box; a file imports what it imports.
  expect(found.find(item => item.id === "sql")!.engines).toEqual(["PostgreSQL", "SQLite"]);
  expect(found.find(item => item.id === "redis")!.files).toEqual([{ path: "api/cache.ts", packages: ["bullmq", "ioredis"] }]);
  // Drivers with no ORM beside them are one database per engine.
  expect(resourcesOf([use("a/pg.ts", "pg"), use("a/lite.ts", "better-sqlite3")], () => "a").map(item => item.id)).toEqual(["postgresql", "sqlite"]);
});

const shop = {
  "package.json": JSON.stringify({ name: "shop" }),
  "src/orders/store.ts": `import { Pool } from "pg";\nimport { Kafka } from "kafkajs";\nexport const pool = new Pool(); export const kafka = new Kafka({ brokers: [] });\n`,
  "src/orders/place.ts": `import { pool } from "./store";\nexport const place = () => pool;\n`,
  "src/files/upload.ts": `import { S3Client } from "@aws-sdk/client-s3";\nimport type Stripe from "stripe";\nexport const s3 = new S3Client({}); export type S = Stripe;\n`,
  "src/files/read.ts": `import { s3 } from "./upload";\nexport const read = () => s3;\n`,
  "src/web/page.ts": `import { place } from "../orders/place";\nimport { read } from "../files/read";\nexport const page = [place, read];\n`,
  "src/web/view.ts": `import { page } from "./page";\nexport const view = page;\n`,
  "src/orders/cancel.ts": `import { pool } from "./store";\nexport const cancel = () => pool;\n`,
  "src/files/remove.ts": `import { s3 } from "./upload";\nexport const remove = () => s3;\n`,
  "src/web/menu.ts": `import { view } from "./view";\nexport const menu = view;\n`,
  "src/web/test/page.test.ts": `import Redis from "ioredis-mock";\nexport const r = new Redis();\n`,
  "db/schema.sql": "create table orders (id int);\n",
};

test("the draft draws what the code talks to: a box per resource with its kind, an arrow from each component that imports it, and its schema mapped to it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-resources-"));
  try {
    await write(directory, shop);
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made.resources).toBe(3);
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  element resource\n  tag database\n  tag queue\n  tag storage\n");
    expect(model).toContain("  postgresql = resource 'PostgreSQL' {\n    #database\n    technology 'pg'\n    description 'Imported by 1 file.'\n  }");
    expect(model).toContain("  orders -> kafka 'kafkajs' {\n    description '1 file'\n  }");
    expect(model).toContain("  files -> s3 '@aws-sdk/client-s3'");
    // A type-only import and a test's mock are no evidence.
    expect(model).not.toContain("stripe");
    expect(model).not.toContain("redis");
    const mapping = JSON.parse(await readFile(join(directory, ".pathlight", "pathlight.activity.json"), "utf8")) as { mappings: { glob: string; element: string }[]; resources: unknown };
    expect(mapping.resources).toEqual([{ element: "kafka", packages: ["kafkajs"] }, { element: "postgresql", packages: ["pg"] }, { element: "s3", packages: ["@aws-sdk/client-s3"] }]);
    expect(mapping.mappings).toContainEqual({ glob: "**/*.sql", element: "postgresql" });
    // LikeC4 accepts it (`queue` and `storage` are words of its grammar, here tag names), and the overview draws the resources beside the components.
    const views = await Effect.runPromise(listViews(directory));
    expect(views.views.some(view => String(view.id) === "index")).toBe(true);

    // `check` judges an arrow to a resource by the packages its source imports, and finds nothing wrong.
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.relationships.filter(item => ["postgresql", "kafka", "s3"].includes(item.target)).map(item => `${item.source}>${item.target} ${item.status} ${item.imports}`).sort())
      .toEqual(["files>s3 supported 1", "orders>kafka supported 1", "orders>postgresql supported 1"]);
    expect(check.resources).toEqual([{ element: "kafka", packages: ["kafkajs"], files: 1 }, { element: "postgresql", packages: ["pg"], files: 1 }, { element: "s3", packages: ["@aws-sdk/client-s3"], files: 1 }]);
    expect(check.summary).toMatchObject({ unusedResources: 0, unsupported: 0, undeclared: 0, unmappedFiles: 0 });

    // The code changes under the model: Kafka is no longer imported, and the web component starts using Postgres with no arrow to it.
    await write(directory, {
      "src/orders/store.ts": `import { Pool } from "pg";\nexport const pool = new Pool();\n`,
      "src/web/view.ts": `import { page } from "./page";\nimport pg from "pg";\nexport const view = [page, pg];\n`,
    });
    const after = await Effect.runPromise(checkWorkspace(directory));
    expect(after.summary).toMatchObject({ unusedResources: 1, unsupported: 1, undeclared: 1 });
    expect(after.undeclared).toEqual([{ source: "web", target: "postgresql", imports: 1, examples: [{ from: "src/web/view.ts", line: 2, to: "pg", kind: "import" }] }]);
    const text = formatCheck(after);
    expect(text).toContain("▲ kafka  no file imports kafkajs any more: is it still used?");
    expect(text).toContain("✓ postgresql  2 files import pg");
    expect(text).toContain("▲ web → postgresql  1 import, e.g. src/web/view.ts:2 → pg");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the viewer names what a resource is on its card's first row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-resources-see-"));
  try {
    await write(directory, shop);
    await Effect.runPromise(draftWorkspace(directory));
    const screen = await run(process.execPath, [resolve("src/cli.ts"), "see", "index", "--workspace", directory, "--cols", "140", "--rows", "40", "--select", "kafka"]);
    const card = (word: string, title: string) => new RegExp(`│ ${word} +│[\\s\\S]*?│ ${title} +│`).test(screen);
    expect(card("queue", "Kafka")).toBe(true);
    expect(card("database", "PostgreSQL")).toBe(true);
    expect(card("storage", "Amazon S3")).toBe(true);
    // The inspector: the name, the packages as its technology, how much code reaches it, and who uses it.
    expect(screen).toContain("Kafka");
    expect(screen).toContain("kafkajs");
    expect(screen).toContain("Imported by 1 file.");

    // The browser draws the same word: it is the terminal's card look, framed for the page.
    const web = await Effect.runPromise(startWebServer(await selectView(directory, "index"), { page: null, theme: "pathlight" }));
    try {
      const response = await fetch(`http://127.0.0.1:${web.port}/api/events?t=${web.token}&cols=140&rows=40&view=index`);
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const frame = (JSON.parse(new TextDecoder().decode(value).slice(6)) as { frame: Frame }).frame;
      const label = (id: string) => frame.cards[id]!.label.map(line => line.map((span: Span) => span.text).join("")).join("\n");
      expect(label("kafka")).toMatch(/^queue\s*\nKafka/);
      expect(label("s3")).toMatch(/^storage\s*\nAmazon S3/);
      await reader.cancel();
    } finally { await web.stop(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
