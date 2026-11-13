import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { acquireModel } from "../src/catalog";
import { crowdedAbove, draftOf, draftWorkspace, renderDraft, runsOf } from "../src/draft";
import { composeFacts, type InfraFile, targetsOf, terraformFacts } from "../src/resources";
import { insideWords } from "../src/viewer/card-view";
import { startWebServer } from "../src/web/server";
import type { Frame, Span } from "../src/web/wire";
import { overlayIn, run, selectView } from "./effects";

// Where it runs (plan phase-7-deployment.md, step 1): each file that runs a resource on the map is a frame of the view `runs`, holding an instance of
// that resource. One box and its instance are one element: one name, Enter into the same view.

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const compose = (path: string, text: string): InfraFile => ({ path, ...composeFacts(text) });
const terraform = (path: string, text: string): InfraFile => ({ path, images: [], env: [], found: terraformFacts(text) });
const shop = {
  "package.json": JSON.stringify({ name: "shop", dependencies: { pg: "1", ioredis: "1" } }),
  "src/db/pool.ts": "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
  "src/cache/client.ts": "import Redis from 'ioredis';\nexport const cache = new Redis();\n",
  "src/api/orders.ts": "import { pool } from '../db/pool';\nimport { cache } from '../cache/client';\nexport const orders = () => [pool, cache];\n",
};
/** The laid-out nodes of one view of a workspace. */
const nodesOf = (workspace: string, id: string) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const source = yield* acquireModel(workspace);
  const model = yield* Effect.promise(() => source.layoutedModel());
  const views = [...model.views()].map(view => view.$view);
  const view = views.find(entry => String(entry.id) === id);
  return { view, views, ids: views.map(entry => String(entry.id)) };
})));
const see = (workspace: string, view: string, ...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), "see", view, "--workspace", workspace, "--cols", "120", "--rows", "30", ...args]);

test("a target is a compose file, a chart or a Terraform folder with the resources it runs by name; tests and an editor's container are not targets", () => {
  const targets = targetsOf([
    compose("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n  web:\n    build: .\n    environment:\n      REDIS_URL: x\n"),
    // Not where the product runs: a test rig named so, one under an editor's folder.
    compose("docker-compose.e2e-dbs.yml", "services:\n  db:\n    image: postgres:16\n"),
    compose(".github/resources/docker-compose.be-test.yml", "services:\n  db:\n    image: mongo\n"),
    compose(".devcontainer/docker-compose.yml", "services:\n  db:\n    image: postgres:16\n"),
    // A compose file that runs only code is no target yet (nothing on the map to instance).
    compose("deploy/docker-compose.yml", "services:\n  web:\n    build: .\n"),
    { path: "charts/shop/Chart.yaml", images: [], env: [], chart: "shop", found: [{ resource: "sql", engine: "postgresql", by: "chart postgresql", name: "postgresql" }] },
    // The chart's own image of the same database is the dependency again, not a second one; a secret says a thing is used, not run here.
    { path: "charts/shop/values.yaml", images: ["bitnami/postgresql", "valkey/valkey"], env: [], found: [{ resource: "mail", by: "secret smtp_creds" }] },
    terraform("infra/db.tf", 'resource "aws_db_instance" "main" {\n  engine = "postgres"\n}\n'),
    terraform("infra/queue.tf", 'resource "aws_sqs_queue" "jobs" {}\n'),
    // A module's definition is not a place anything runs; nor is a compose file named for integration tests.
    terraform("infra/modules/db/main.tf", 'resource "aws_db_instance" "this" {\n  engine = "postgres"\n}\n'),
    compose("docker-compose.integration.yml", "services:\n  db:\n    image: postgres:16\n"),
  ]);
  expect(targets.map(target => [target.path, target.format, target.runs.map(item => `${item.name}=${item.engine ?? item.resource}`)])).toEqual([
    ["charts/shop", "chart", ["postgresql=postgresql", "valkey=redis"]],
    ["docker-compose.yml", "compose", ["db=postgresql", "cache=redis"]],
    ["infra", "terraform", ["main=postgresql", "jobs=sqs"]],
  ]);
});

test("the draft frames each file with instances of the map's resources, never a box of another engine, and names twins by their services", () => {
  const scan = { files: Object.keys(shop).filter(path => path.endsWith(".ts")).map(path => ({ path, lines: 3 })), imports: [], external: [
    { from: "src/db/pool.ts", package: "pg", line: 1, kind: "import" }, { from: "src/cache/client.ts", package: "ioredis", line: 1, kind: "import" }] };
  const draft = draftOf(scan as never, [{ directory: "", name: "shop" }], undefined, [], [
    compose("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  replica:\n    image: postgres:16\n  cache:\n    image: redis:7\n  legacy:\n    image: mysql:8\n  search:\n    image: getmeili/meilisearch:v1\n"),
  ]);
  const sql = draft.resources.find(item => item.sql)!.element, redis = draft.resources.find(item => item.id === "redis")!.element, search = draft.resources.find(item => item.id === "meilisearch")!.element;
  // MySQL is not on the map (the code names PostgreSQL), so the `legacy` service is no instance of the PostgreSQL box.
  expect(runsOf(draft).map(entry => [entry.target, entry.name, entry.elements])).toEqual([
    ["docker-compose.yml", "db", [sql]], ["docker-compose.yml", "replica", [sql]], ["docker-compose.yml", "cache", [redis]], ["docker-compose.yml", "search", [search]]]);
  // Two services run the one database: each instance takes its service's name; the others keep the resource's title.
  expect(draft.targets[0]!.instances.map(instance => instance.title)).toEqual(["db", "replica", undefined, undefined]);
  expect(draft.targets[0]!.key).toBe("runs:docker-compose.yml");
});

test("a drafted map with a compose file and Terraform compiles, lists Where it runs after the overview, and its instances are the resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-"));
  try {
    await write(directory, { ...shop,
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n",
      "docker-compose.test.yml": "services:\n  db:\n    image: postgres:16\n",
      "infra/main.tf": 'resource "aws_db_instance" "orders" {\n  engine = "postgres"\n}\n',
    });
    await writeFile(overlayIn(directory), JSON.stringify({ version: 1, elements: { "runs:infra": { title: "Production (AWS)", by: "human" } } }));
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect(made.unknown).toEqual([]);
    const mapping = JSON.parse(await readFile(join(directory, ".pathlight", "pathlight.activity.json"), "utf8")) as { entries: string[] };
    expect(mapping.entries).toContain("runs");
    const { view, ids } = await nodesOf(directory, "runs");
    expect(ids.indexOf("runs")).toBe(ids.indexOf("index") + 1);
    const nodes = view!.nodes.map(node => ({ id: String(node.id), kind: String(node.kind), ref: node.modelRef ? String(node.modelRef) : undefined, title: node.title, opens: node.navigateTo ? String(node.navigateTo) : undefined }));
    // Two frames (the test compose file is none); the Terraform one carries the person's name for it.
    expect(nodes.filter(node => node.kind === "target").map(node => node.title).sort()).toEqual(["Production (AWS)", "docker-compose.yml"]);
    const instances = nodes.filter(node => node.kind === "instance");
    expect(instances.map(node => [node.id, node.ref]).sort()).toEqual([["docker_compose_yml.cache", "redis"], ["docker_compose_yml.db", "postgresql"], ["infra.orders", "postgresql"]]);
    // An instance opens what its element opens: who uses the database.
    expect(instances.find(node => node.id === "docker_compose_yml.db")!.opens).toBe("postgresql_users");
    // Through the real viewer: the card says `database`, and Enter on it lands on the resource's users with Back.
    const screen = await see(directory, "runs");
    expect(screen).toMatch(/│ database +│/);
    expect(screen).toMatch(/│ cache +│/);
    const entered = await see(directory, "runs", "--select", "postgresql", "--keys", "Enter");
    expect(entered.split("\n")[0]).toContain("Who uses PostgreSQL");
    expect(entered.split("\n")[1]).toContain("back 1");
    // The browser page frames the same card: the word on its first row, then the resource's name.
    const web = await Effect.runPromise(startWebServer(await selectView(directory, "runs"), { page: null, theme: "pathlight" }));
    try {
      const response = await fetch(`http://127.0.0.1:${web.port}/api/events?t=${web.token}&cols=140&rows=40&view=runs`);
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const frame = (JSON.parse(new TextDecoder().decode(value).slice(6)) as { frame: Frame }).frame;
      expect(frame.cards["docker_compose_yml.db"]!.label.map(line => line.map((span: Span) => span.text).join("")).join("\n")).toMatch(/^database\s*\nPostgreSQL/);
      await reader.cancel();
    } finally { await web.stop(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("names LikeC4 reserves still compile, and frames at the workspace root are told apart by the file that makes each one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-names-"));
  try {
    // `this` is the usual name of a Terraform block; `it` and `this` are reserved beyond the grammar's keywords. A root chart and root Terraform.
    await write(directory, { ...shop,
      "main.tf": 'resource "aws_db_instance" "this" {\n  engine = "postgres"\n}\n',
      "Chart.yaml": "apiVersion: v2\nname: shop\ndependencies:\n  - name: redis\n",
      "docker-compose.yml": "services:\n  it:\n    image: postgres:16\n  view:\n    image: redis:7\n",
    });
    await Effect.runPromise(draftWorkspace(directory));
    // Through the viewer, which stops on a model that does not compile.
    const screen = await see(directory, "runs");
    expect(screen.split("\n")[0]).toContain("Where it runs");
    const { view } = await nodesOf(directory, "runs");
    expect(view!.nodes.filter(node => String(node.kind) === "target").map(node => node.title).sort()).toEqual(["*.tf", "Chart.yaml", "docker-compose.yml"]);
    expect(view!.nodes.filter(node => String(node.kind) === "instance")).toHaveLength(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("no file that runs a resource means no view, and infrastructure drawn as programs gets none either", () => {
  const scan = { files: [{ path: "src/a.ts", lines: 1 }], imports: [], external: [] };
  const plain = draftOf(scan as never, [{ directory: "", name: "tool" }], undefined, [], []);
  expect(plain.targets).toEqual([]);
  const rendered = renderDraft(plain);
  expect(rendered.text).not.toContain("deployment");
  expect(rendered.entries).not.toContain("runs");
  // More programs than code files: the compose file is drawn as its services (R2), which already is the picture.
  const mostly = draftOf(scan as never, [{ directory: "", name: "stack" }], undefined, [], [
    compose("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  web:\n    image: acme/web\n    depends_on: [db]\n  worker:\n    image: acme/worker\n    depends_on: [db]\n"),
  ]);
  expect(mostly.packages.some(item => item.runs)).toBe(true);
  expect(mostly.targets).toEqual([]);
});

test("past the crowded count each frame is one closed box that opens its own view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-crowded-"));
  try {
    const services = (count: number) => `services:\n${Array.from({ length: count }, (_, index) => `  db${index}:\n    image: postgres:16\n`).join("")}`;
    const half = Math.floor(crowdedAbove / 2) + 1;
    await write(directory, { ...shop, "docker-compose.yml": services(half), "docker-compose.prod.yml": services(half) });
    await Effect.runPromise(draftWorkspace(directory));
    const { view, views } = await nodesOf(directory, "runs");
    expect(view!.nodes.map(node => [String(node.id), String(node.navigateTo)]).sort()).toEqual([["docker_compose_prod_yml", "runs_docker_compose_prod_yml"], ["docker_compose_yml", "runs_docker_compose_yml"]]);
    const frame = views.find(entry => String(entry.id) === "runs_docker_compose_yml")!;
    expect(frame.nodes.filter(node => String(node.kind) === "instance")).toHaveLength(half);
    // The closed frame says how many boxes are inside it, as a box that opens does.
    expect(await see(directory, "runs")).toContain(`[${half}]`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("an instance says what its resource says, and an instance of anything else says nothing new", () => {
  const view = { id: "runs", nodes: [
    { id: "f.db", kind: "instance", modelRef: "postgresql", tags: ["database"], navigateTo: "postgresql_users", children: [] },
    // A person's model may tag any element `queue`: only an instance of a resource takes the word.
    { id: "f.api", kind: "instance", modelRef: "shop.api", tags: ["queue"], children: [] },
  ] };
  expect(insideWords(view, new Set(), new Set(["postgresql"]))).toEqual(new Map([["f.db", "database"]]));
});
