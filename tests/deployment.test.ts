import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { acquireModel } from "../src/catalog";
import { crowdedAbove, draftOf, draftWorkspace, renderDraft, runsOf } from "../src/draft";
import { RGBA } from "@opentui/core";
import type { ActivityEvent } from "../src/activity";
import { composeFacts, dockerfileFacts, type InfraFile, procfileFacts, readInfra, targetsOf, terraformFacts } from "../src/resources";
import { eventsLighting, nowCard } from "../src/viewer/activity-view";
import { insideWords } from "../src/viewer/card-view";
import { startWebServer } from "../src/web/server";
import type { Frame, Span } from "../src/web/wire";
import { overlayIn, run, selectView, toolActivity, writeActivity } from "./effects";

// Where it runs (plan phase-7-deployment.md, steps 1 to 3): each file that runs a resource on the map or this repository's code is a frame of the
// view `runs`, holding an instance of that resource and of each box a service is tied to by its build, its Dockerfile or its command (never its image).
// One box and its instance are one element: one name, Enter into the same view, the same activity.

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
    // A compose file that runs only code is a target with its services; the draft decides whether it is a frame.
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
  expect(targets.map(target => [target.path, target.format, target.runs.map(item => `${item.name}=${item.engine ?? item.resource}`), target.services.map(item => item.name)])).toEqual([
    ["charts/shop", "chart", ["postgresql=postgresql", "valkey=redis"], []],
    ["deploy/docker-compose.yml", "compose", [], ["web"]],
    ["docker-compose.yml", "compose", ["db=postgresql", "cache=redis"], ["web"]],
    ["infra", "terraform", ["main=postgresql", "jobs=sqs"], []],
  ]);
  expect(targets.find(target => target.path === "docker-compose.yml")!.services[0]!.build).toEqual({ context: "." });
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

// Step 2: the tie. A small monorepo: `api` (holding its own test package `api/e2e`), `web`, a Rust `worker` declaring the binary `fleet-worker`, and
// the root package `fleet` with a `start` script.
// More files of code than services, or R2 would draw the compose file as programs (a repository that is mostly infrastructure).
const fleetFiles = ["api/src/server.ts", "api/src/routes.ts", "api/e2e/flow.ts", "web/src/app.ts", "web/src/page.ts", "worker/src/main.rs", ...Array.from({ length: 30 }, (_, index) => `tools/task${index}.ts`)];
const fleetManifests = [
  { directory: "", name: "fleet", starts: [{ name: "start", kind: "script" as const, by: "package.json script start" }] },
  { directory: "api", name: "api", starts: [{ name: "start", kind: "script" as const, by: "api/package.json script start" }] }, { directory: "api/e2e", name: "api-e2e" }, { directory: "web", name: "web" },
  { directory: "worker", name: "worker", starts: [{ name: "fleet-worker", kind: "binary" as const, by: "worker/Cargo.toml bin fleet-worker" }] },
];
const dockerfile = (path: string, text: string): InfraFile => ({ path, images: [], env: [], dockerfile: dockerfileFacts(text) });
const fleet = (infra: InfraFile[]) => draftOf({ files: fleetFiles.map(path => ({ path, lines: 3 })), imports: [], external: [] } as never, fleetManifests, undefined, [], infra);

test("a service is tied by its build context, its Dockerfile's names or its command, and never by its image", () => {
  const draft = fleet([
    compose("docker-compose.yml", [
      "services:",
      // Rung 1: the context is a package's folder (it holds the test package `api/e2e`, which is its own), or holds one package.
      "  api:\n    build: ./api",
      "  web:\n    build:\n      context: web",
      // Rung 2: the root holds several packages; the Dockerfile copies two of them. `COPY . .` narrows nothing.
      "  all:\n    build:\n      context: .\n      dockerfile: deploy/all.Dockerfile",
      "  everything:\n    build:\n      context: .\n      dockerfile: deploy/whole.Dockerfile",
      "  rusty:\n    build:\n      context: .\n      dockerfile: deploy/rust.Dockerfile",
      // Rung 3: the command runs a declared binary, or a package manager runs a declared script.
      '  worker:\n    image: acme/queue\n    command: ["fleet-worker", "--queue", "jobs"]',
      "  cron:\n    image: node:22\n    command: yarn run start",
      // An image named after a package says nothing about which code it is; neither does a script nobody declares.
      "  web-image:\n    image: acme/web:latest",
      "  other:\n    image: node:22\n    command: yarn lint",
      // A folder of configuration beside a root with code of its own is no package's code; a remote context is no folder here.
      "  proxy:\n    build: ./nginx",
      "  remote:\n    build: https://github.com/acme/thing.git#main",
      "",
    ].join("\n")),
    // A script is the one the compose file's own folder declares, not the root's of the same name.
    compose("api/docker-compose.yml", "services:\n  dev:\n    image: node:22\n    command: npm start\n"),
    dockerfile("nginx/Dockerfile", "FROM nginx\nCOPY nginx.conf /etc/nginx/\n"),
    dockerfile("deploy/all.Dockerfile", "FROM node AS build\nCOPY --from=base /x /x\nCOPY web ./web\nCOPY \\\n  api ./api\nCOPY package.json .\nCMD [\"node\", \"api/src/server.js\"]\n"),
    dockerfile("deploy/whole.Dockerfile", "FROM node\nCOPY . .\nCMD [\"node\", \"server.js\"]\n"),
    dockerfile("deploy/rust.Dockerfile", "FROM rust\nCOPY . .\nRUN cargo build --release --bin fleet-worker && strip target/release/fleet-worker\n"),
  ]);
  const id = (directory: string) => draft.packages.find(item => item.directory === directory)!.id;
  const tied = Object.fromEntries(runsOf(draft).map(entry => [`${entry.target}#${entry.name}`, entry.elements]));
  const root = (name: string) => `docker-compose.yml#${name}`;
  expect(tied).toEqual({
    [root("api")]: [id("api")], [root("web")]: [id("web")], [root("all")]: [id("api"), id("web")].sort(), [root("everything")]: [], [root("rusty")]: [id("worker")],
    [root("worker")]: [id("worker")], [root("cron")]: [id("")], [root("web-image")]: [], [root("other")]: [], [root("proxy")]: [], [root("remote")]: [],
    "api/docker-compose.yml#dev": [id("api")],
  });
  // Each tie says what it rests on.
  expect(draft.targets.find(target => target.path === "docker-compose.yml")!.services.find(item => item.name === "all")!.by).toContain("COPY web");
});

test("what a Dockerfile runs is its last stage's entrypoint, else its command", () => {
  expect(dockerfileFacts("FROM rust AS build\nENTRYPOINT [\"cargo\"]\nFROM debian\nCMD [\"fleet-worker\", \"serve\"]\n").command).toBe("fleet-worker serve");
  expect(dockerfileFacts("FROM debian\nENTRYPOINT [\"fleet-worker\"]\nCMD [\"serve\"]\n").command).toBe("fleet-worker");
});

test("a plain service's arrow goes to the service it names, not to the first instance of the same resource", () => {
  const draft = fleet([compose("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  authdb:\n    image: postgres:16\n  api:\n    build: ./api\n  auth:\n    image: acme/auth\n    depends_on: [authdb]\n")]);
  const target = draft.targets[0]!, authdb = target.instances.find(item => item.name === "authdb")!;
  expect(target.services.find(item => item.name === "auth")!.uses!.map(use => use.to)).toEqual([authdb.id]);
});

test("a file whose services run nothing this map knows is no frame, and past the cap the plain services fold into one box", () => {
  expect(fleet([compose("docker-compose.yml", "services:\n  proxy:\n    image: nginx\n  tool:\n    image: acme/tool\n")]).targets).toEqual([]);
  const plain = Array.from({ length: 20 }, (_, index) => `  tool${index}:\n    image: acme/tool${index}\n`).join("");
  const draft = fleet([compose("docker-compose.yml", `services:\n  api:\n    build: ./api\n${plain}`)]);
  const services = draft.targets[0]!.services;
  expect(services.find(item => item.name === "api")!.folded).toBeUndefined();
  expect(services.filter(item => item.folded)).toHaveLength(20);
  // Folded or not, every service is still listed where the frame is (the mapping and the scorer read it).
  expect(runsOf(draft)).toHaveLength(21);
});

test("a drafted map draws a service of several boxes as a frame of cards, a plain service with its arrows, and no arrow between two files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-tie-"));
  try {
    await write(directory, {
      "package.json": JSON.stringify({ name: "fleet" }),
      "api/package.json": JSON.stringify({ name: "api", dependencies: { pg: "1" } }),
      "api/src/server.ts": "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
      "web/package.json": JSON.stringify({ name: "web" }),
      "web/src/app.ts": "export const app = 1;\n",
      // More files of code than services, or R2 would draw the compose files as programs.
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`web/src/part${index}.ts`, `export const part${index} = ${index};\n`])),
      "deploy/all.Dockerfile": "FROM node\nCOPY web ./web\nCOPY api ./api\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  proxy:\n    image: nginx\n    depends_on: [db]\n",
      // No database of their own: LikeC4 would draw these files' api to the other file's database.
      "docker-compose.prod.yml": "services:\n  api:\n    build: ./api\n",
      "docker-compose.bundle.yml": "services:\n  all:\n    build:\n      context: .\n      dockerfile: deploy/all.Dockerfile\n",
    });
    await Effect.runPromise(draftWorkspace(directory));
    const { view } = await nodesOf(directory, "runs");
    const nodes = view!.nodes, byId = new Map(nodes.map(node => [String(node.id), node]));
    const sql = String(byId.get("docker_compose_yml.db")!.modelRef);
    // The two-box service is a frame holding an instance of each box; the one-box service is an instance named by its service.
    const all = byId.get("docker_compose_bundle_yml.all")!;
    expect(String(all.kind)).toBe("service");
    expect(all.children.map(child => String(byId.get(String(child))!.modelRef)).sort()).toEqual(["api", "web"]);
    expect([String(byId.get("docker_compose_prod_yml.api")!.modelRef), byId.get("docker_compose_prod_yml.api")!.title]).toEqual(["api", "api"]);
    // The plain service draws its `depends_on` to the database instance in its own file.
    expect(view!.edges.some(edge => String(edge.source) === "docker_compose_yml.proxy" && String(edge.target) === "docker_compose_yml.db")).toBe(true);
    // The model's arrow api → database is drawn inside a file, never from one file's api to the other file's database.
    const frameOf = (id: unknown) => String(id).split(".")[0];
    expect(view!.edges.filter(edge => frameOf(edge.source) !== frameOf(edge.target))).toEqual([]);
    expect(sql).toBe("postgresql");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("an instance is lit by work anywhere inside its element; anywhere else a closed parent stays dark", () => {
  const now = Date.now();
  const event: ActivityEvent = { version: 1, source: "claude", session: "s", call: "c1", tool: "Edit", phase: "completed", operation: "edit", paths: ["api/src/routes.ts"], time: now - 1000 };
  const byElement = new Map([["api.routes", [event]], ["api.server", [event]]]);
  expect(eventsLighting(byElement, "api", true)).toEqual([event]);
  expect(eventsLighting(byElement, "api", false)).toEqual([]);
  // `api_2` is not inside `api`.
  expect(eventsLighting(new Map([["api_2.x", [event]]]), "api", true)).toEqual([]);
  // The inspector's Work card of the selected instance shows that work too.
  const config = { version: 1 as const, project: "fleet", mappings: [{ glob: "api/src/routes.ts", element: "api.routes" }] };
  const work = (instance: boolean) => nowCard({ error: "", bound: true, following: false, config, events: [event], element: "api", instance, now, width: 40, flashes: new Map(), background: RGBA.fromHex("#000000") }).chunks.map(chunk => chunk.text).join("");
  expect(work(true)).toContain("routes.ts");
  expect(work(false)).not.toContain("routes.ts");
});

test("through the viewer, an edit inside a package lights its instance where it runs and not the closed package on the overview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-lit-"));
  try {
    // `api` opens into children, so on the overview it is a closed parent, which activity inside never lights. The root's own file makes two packages.
    await write(directory, {
      "package.json": JSON.stringify({ name: "fleet" }),
      "tools/seed.ts": "export const seed = 1;\n",
      "api/package.json": JSON.stringify({ name: "api", dependencies: { pg: "1" } }),
      "api/src/server.ts": "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
      ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`api/src/routes/r${index}.ts`, `export const r${index} = ${index};\n`])),
      ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`api/src/part${index}.ts`, `export const p${index} = ${index};\n`])),
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  api:\n    build: ./api\n",
    });
    await Effect.runPromise(draftWorkspace(directory));
    await writeActivity(directory, { ...toolActivity(directory, { source: "claude", session: "lit" }, "c1", "Edit", { file_path: join(directory, "api/src/routes/r1.ts") }, "completed"), time: Date.now() });
    const lit = (screen: string) => screen.split("\n").some(line => /╭─+ ✓ done ─╮/.test(line));
    expect(lit(await see(directory, "runs", "--follow"))).toBe(true);
    expect(lit(await see(directory, "index", "--follow"))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

// Step 3: the files that run things and are nothing else. A Procfile and a systemd unit name no image, so they run this repository's code.
test("Procfiles, systemd units, Kubernetes workloads and compose files in a compose folder are read as targets; other YAML is not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-runners-"));
  try {
    const files = {
      "Procfile": "# processes\nweb: yarn start --port $PORT\nrelease: ./bin/migrate\n",
      "deploy/app.service": "[Unit]\nAfter=postgresql.service\nExecStart=/not/here\n[Service]\nExecStart=-/usr/bin/app-server start\n[Install]\nWantedBy=multi-user.target\n",
      // A pod's containers are its services: the database container is the resource, the init container runs nothing that stays.
      "k8s/app.yaml": "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: app\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      initContainers:\n        - name: wait\n          image: busybox\n      containers:\n        - name: app\n          image: acme/app:1\n          command: [app-server]\n          args: [start]\n        - name: db\n          image: postgres:14\n",
      "k8s/secrets.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\n",
      "contrib/docker-compose/basic.yml": "services:\n  db:\n    image: postgres:16\n  app:\n    image: acme/app\n",
      // `services:` in a file whose folder is not named for compose is not a compose file; an editor's container is not where it runs.
      "config/services.yml": "services:\n  db:\n    image: postgres:16\n",
      ".devcontainer/compose/dev.yml": "services:\n  db:\n    image: postgres:16\n",
    };
    await write(directory, files);
    const infra = await Effect.runPromise(readInfra(directory, Object.keys(files)));
    const targets = targetsOf(infra);
    expect(targets.map(target => [target.path, target.format, target.runs.map(item => `${item.name}=${item.engine ?? item.resource}`), target.services.map(item => `${item.name}:${item.command ?? item.image}`)])).toEqual([
      ["Procfile", "procfile", [], ["web:yarn start --port $PORT", "release:./bin/migrate"]],
      ["contrib/docker-compose/basic.yml", "compose", ["db=postgresql"], ["app:acme/app"]],
      ["deploy/app.service", "systemd", [], ["app:/usr/bin/app-server start"]],
      ["k8s/app.yaml", "kubernetes", ["db=postgresql"], ["app:app-server start"]],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const procfile = (path: string, text: string): InfraFile => ({ path, images: [], env: [], runner: { format: "procfile", processes: procfileFacts(text) } });
const unit = (path: string, command: string): InfraFile => ({ path, images: [], env: [], runner: { format: "systemd", processes: [{ name: path.split("/").at(-1)!.replace(/\.service$/, ""), kind: "unit", uses: [], command }] } });

test("a Procfile or a unit is a frame even when no line is tied, and a command naming a declared start ties it", () => {
  const draft = fleet([procfile("Procfile", "web: yarn start\ncron: ./bin/sweep\n"), unit("deploy/worker.service", "/usr/bin/fleet-worker --queue jobs"), unit("deploy/other.service", "/usr/bin/other")]);
  const id = (directory: string) => draft.packages.find(item => item.directory === directory)!.id;
  expect(Object.fromEntries(runsOf(draft).map(entry => [`${entry.target}#${entry.name}`, entry.elements]))).toEqual({
    "Procfile#web": [id("")], "Procfile#cron": [], "deploy/worker.service#worker": [id("worker")], "deploy/other.service#other": [],
  });
  // An untied line says what it runs.
  expect(draft.targets.find(target => target.path === "deploy/other.service")!.services[0]!.by).toContain("/usr/bin/other");
});

// A flat draft (one package) draws no package box: what runs it is every top-level box together.
const flatFiles = [...Array.from({ length: 4 }, (_, index) => `server/s${index}.ts`), ...Array.from({ length: 4 }, (_, index) => `app/a${index}.ts`), "shared/types.ts"];
const flat = (infra: InfraFile[]) => draftOf({ files: flatFiles.map(path => ({ path, lines: 3 })), imports: [], external: [] } as never,
  [{ directory: "", name: "outline", starts: [{ name: "start", kind: "script" as const, by: "package.json script start" }] }], undefined, [], infra);

test("in a flat draft a process that runs the package is tied to every top-level box, one closed card", () => {
  const draft = flat([procfile("Procfile", "web: yarn start\n"), procfile("server/collab/Procfile", "web: yarn start --services=collaboration\n")]);
  expect(draft.flat).toBe(true);
  const top = [...new Set(draft.packages.flatMap(item => [...item.components, ...item.folders, ...item.groups].map(entry => entry.id).filter(id => !id.includes("."))))].sort();
  expect(top.length).toBeGreaterThan(1);
  for (const entry of runsOf(draft)) expect([...entry.elements].sort()).toEqual(top);
  const web = draft.targets[0]!.services[0]!;
  expect(web.whole).toBe(true);
  // The view includes the service, never its instances: one card.
  const model = renderDraft(draft).text;
  expect(model).toContain(`include ${draft.targets[0]!.id}, ${draft.targets[0]!.id}.*\n`);
  expect(model).not.toContain(`${draft.targets[0]!.id}.${web.id}.*`);
});

test("a deployment card drawn closed is lit by work in any element of the instances inside it", () => {
  const now = Date.now();
  const event: ActivityEvent = { version: 1, source: "claude", session: "s", call: "c1", tool: "Edit", phase: "completed", operation: "edit", paths: ["server/s1.ts"], time: now - 1000 };
  expect(eventsLighting(new Map([["server.s1", [event]]]), ["app", "server"], true)).toEqual([event]);
  expect(eventsLighting(new Map([["shared.types", [event]]]), ["app", "server"], true)).toEqual([]);
});

test("through the viewer, an edit anywhere in a one-package repository lights the closed card of the process that runs it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-whole-"));
  try {
    await write(directory, {
      "package.json": JSON.stringify({ name: "notes", scripts: { start: "node server/main.js" } }),
      ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`server/s${index}.ts`, `export const s${index} = ${index};\n`])),
      ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`app/a${index}.ts`, `export const a${index} = ${index};\n`])),
      "Procfile": "web: yarn start\n",
    });
    await Effect.runPromise(draftWorkspace(directory));
    const { view } = await nodesOf(directory, "runs");
    expect(view!.nodes.map(node => String(node.kind)).sort()).toEqual(["service", "target"]);
    await writeActivity(directory, { ...toolActivity(directory, { source: "claude", session: "whole" }, "c1", "Edit", { file_path: join(directory, "app/a1.ts") }, "completed"), time: Date.now() });
    const lit = (screen: string) => screen.split("\n").some(line => /╭─+ ✓ done ─╮/.test(line));
    expect(lit(await see(directory, "runs", "--follow"))).toBe(true);
    // The plan is judged against the boxes the card stands for: work inside a planned box is not off plan, work outside one is.
    const plan = (id: string) => run(process.execPath, [resolve("src/cli.ts"), "plan", id, "--workspace", directory]);
    await plan("app");
    expect(await see(directory, "runs", "--follow")).not.toContain("off plan");
    await plan("server");
    expect(await see(directory, "runs", "--follow")).toContain("off plan");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("a closed frame on a crowded overview is not lit by the work of what it holds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-deployment-frame-"));
  try {
    // Seven files of three boxes each (the frame, its database, its api) are just past the crowded count: every frame is one closed box.
    const files = Object.fromEntries(Array.from({ length: Math.floor(crowdedAbove / 3) + 1 }, (_, index) => [`deploy/s${index}/docker-compose.yml`, "services:\n  db:\n    image: postgres:16\n  api:\n    build: ../../api\n"]));
    await write(directory, {
      "package.json": JSON.stringify({ name: "fleet" }),
      "tools/seed.ts": "export const seed = 1;\n",
      "api/package.json": JSON.stringify({ name: "api", dependencies: { pg: "1" } }),
      "api/src/server.ts": "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`api/src/part${index}.ts`, `export const p${index} = ${index};\n`])),
      ...files,
    });
    await Effect.runPromise(draftWorkspace(directory));
    const { view } = await nodesOf(directory, "runs");
    expect(view!.nodes.every(node => String(node.kind) === "target" && node.children.length === 0)).toBe(true);
    await writeActivity(directory, { ...toolActivity(directory, { source: "claude", session: "frame" }, "c1", "Edit", { file_path: join(directory, "api/src/server.ts") }, "completed"), time: Date.now() });
    // Tall enough that a lit card would show its tag.
    expect(await see(directory, "runs", "--follow", "--rows", "60")).not.toContain("✓ done");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("two workloads in one manifest with containers of the same name keep a name each", async () => {
  const { kubernetesFacts } = await import("../src/resources");
  const pod = (name: string) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: acme/${name}\n        - name: ${name}-db\n          image: postgres:16\n`;
  const facts = kubernetesFacts(`${pod("web")}---\n${pod("worker")}`);
  expect(facts.processes.map(item => item.name)).toEqual(["web/app", "worker/app"]);
  expect(facts.services.map(item => item.name)).toEqual(["web-db", "worker-db"]);
});
