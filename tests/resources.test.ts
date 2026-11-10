import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { checkWorkspace, formatCheck } from "../src/check";
import { listViews } from "../src/catalog";
import { draftWorkspace } from "../src/draft";
import { chartFacts, composeFacts, programsOf, entryFor, envNames, imageResource, isInfraFile, resourceKinds, resourcesOf, templateFacts, terraformFacts, valuesFacts, withInfra } from "../src/resources";
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
  // `api`'s SQLite joins `legacy`'s box, which already lists SQLite; PlanetScale, which no generic box lists, stays its own.
  expect(found.map(item => [item.id, item.title, item.kind, item.files.length])).toEqual([
    ["planetscale", "PlanetScale", "database", 2], ["redis", "Redis", "cache", 1], ["sql", "SQL database", "database", 5],
  ]);
  // The ORM's package and each driver's package lead to the same box; a file imports what it imports.
  expect(found.find(item => item.id === "sql")!.engines).toEqual(["PostgreSQL", "SQLite"]);
  expect(found.find(item => item.id === "redis")!.files).toEqual([{ path: "api/cache.ts", packages: ["bullmq", "ioredis"] }]);
  // Drivers with no ORM beside them are one database per engine.
  expect(resourcesOf([use("a/pg.ts", "pg"), use("a/lite.ts", "better-sqlite3")], () => "a").map(item => item.id)).toEqual(["postgresql", "sqlite"]);

  // One database across packages where the evidence allows: a generic box and one engine in the whole workspace are that engine, and an engine
  // box joins a generic box that already lists its engine (Infisical).
  const scopeOf = (path: string) => path.split("/")[0]!;
  expect(resourcesOf([use("go/db.go", "database/sql"), use("pg/db.go", "github.com/jackc/pgx/v5")], scopeOf).map(item => [item.id, item.files.length])).toEqual([["postgresql", 2]]);
  const joined = resourcesOf([use("go/db.go", "github.com/jackc/pgx/v5"), use("api/db.ts", "knex"), use("api/pg.ts", "pg"), use("api/my.ts", "mysql2")], scopeOf);
  expect(joined.map(item => [item.id, item.files.length, item.engines])).toEqual([["sql", 4, ["MySQL", "PostgreSQL"]]]);
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
    expect(mapping.resources).toEqual([{ element: "kafka", resource: "kafka", packages: ["kafkajs"] }, { element: "postgresql", resource: "postgresql", packages: ["pg"] }, { element: "s3", resource: "s3", packages: ["@aws-sdk/client-s3"] }]);
    expect(mapping.mappings).toContainEqual({ glob: "**/*.sql", element: "postgresql" });
    // LikeC4 accepts it (`queue` and `storage` are words of its grammar, here tag names), and the overview draws the resources beside the components.
    const views = await Effect.runPromise(listViews(directory));
    expect(views.views.some(view => String(view.id) === "index")).toBe(true);

    // `check` judges an arrow to a resource by the packages its source imports, and finds nothing wrong.
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.relationships.filter(item => ["postgresql", "kafka", "s3"].includes(item.target)).map(item => `${item.source}>${item.target} ${item.status} ${item.imports}`).sort())
      .toEqual(["files>s3 supported 1", "orders>kafka supported 1", "orders>postgresql supported 1"]);
    expect(check.resources).toEqual([{ element: "kafka", packages: ["kafkajs"], files: 1, declared: [] }, { element: "postgresql", packages: ["pg"], files: 1, declared: [] }, { element: "s3", packages: ["@aws-sdk/client-s3"], files: 1, declared: [] }]);
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

test("infrastructure files are read as names only: a compose file's images and environment names, an example environment's names", () => {
  expect(composeFacts(`services:\n  db:\n    image: docker.io/library/postgres:16-alpine\n    environment:\n      - POSTGRES_PASSWORD=secret\n  app:\n    image: acme/app\n    environment:\n      REDIS_URL: redis://cache\n      TOKEN: \${STRIPE_KEY:-x}\n`))
    .toEqual({ images: ["acme/app", "docker.io/library/postgres:16-alpine"], env: ["POSTGRES_PASSWORD", "REDIS_URL", "STRIPE_KEY", "TOKEN"], found: [],
      programs: [{ name: "app", kind: "service", image: "acme/app", uses: [{ resource: "redis", by: "REDIS_URL" }] }] });
  // A service built here is looked up by its name, and says so; a built service with a known image, or an unknown name, adds nothing.
  expect(composeFacts("services:\n  clickhouse:\n    image: clickhouse-self-hosted-local\n    build:\n      context: ./clickhouse\n  web:\n    build: .\n  db:\n    image: postgres:16\n    build: ./db\n").found)
    .toEqual([{ resource: "clickhouse", by: "service clickhouse, built here" }]);
  expect(envNames("# comment\nDATABASE_URL=postgres://user:pw@host/db\nexport SMTP_HOST=mail\n  lower=1\nNOT A LINE\n")).toEqual(["DATABASE_URL", "SMTP_HOST"]);
  expect(["postgres:16", "bitnami/postgresql:15@sha256:abc", "ghcr.io/x/redis:7", "valkey/valkey", "acme/app"].map(imageResource)).toEqual(["postgresql", "postgresql", "redis", "redis", undefined]);
  expect([".env.example", "docker/docker-compose.dev.yml", "compose.yaml", "frontend/template.env", "tests/e2e/docker-compose.yml", ".env", "src/env.ts"].map(isInfraFile))
    .toEqual([true, true, true, true, false, false, false]);
});

test("infrastructure names what the code leaves open and adds only datastores it runs, each saying so", () => {
  const code = resourcesOf([use("api/db.ts", "sequelize"), use("api/cache.ts", "ioredis")], () => "api");
  const compose = { path: "docker-compose.yml", images: ["postgres:16", "redis:7", "getmeili/meilisearch:v1", "caronc/apprise:1.0"], env: ["SENTRY_DSN"] };
  const joined = withInfra(code, [compose, { path: ".env.example", images: [], env: ["DATABASE_URL", "REDIS_URL", "MONGO_URL"] }]);
  // The ORM's database takes the engine compose runs; Redis is confirmed by both files; Meilisearch runs with no code, so it is a box that says so.
  expect(joined.map(item => [item.id, item.title, item.files.length, item.declared.map(entry => `${entry.path}: ${entry.by}`)])).toEqual([
    ["meilisearch", "Meilisearch", 0, ["docker-compose.yml: image getmeili/meilisearch:v1"]],
    ["redis", "Redis", 1, [".env.example: REDIS_URL", "docker-compose.yml: image redis:7"]],
    ["sql", "PostgreSQL", 1, [".env.example: DATABASE_URL", "docker-compose.yml: image postgres:16"]],
  ]);
  // Apprise (a service), Sentry (monitoring) and MongoDB (an environment name only) add nothing. Code that names two engines keeps both.
  const two = resourcesOf([use("a/db.py", "sqlalchemy"), use("a/pg.py", "psycopg2"), use("a/lite.py", "sqlite3")], () => "a");
  expect(withInfra(two, [compose]).find(item => item.sql)!.title).toBe("SQL database");
  // With no code that reaches a database, an engine's image is one.
  expect(withInfra([], [compose]).map(item => item.id)).toEqual(["meilisearch", "postgresql", "redis"]);
});

test("the draft cites the infrastructure, and check asks about a box only infrastructure declares without counting it as a finding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-resources-infra-"));
  try {
    await write(directory, { ...shop, "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  search:\n    image: getmeili/meilisearch:v1.8\n", ".env.example": "DATABASE_URL=\nKAFKA_BROKERS=\n" });
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  postgresql = resource 'PostgreSQL' {\n    #database\n    technology 'pg'\n    description 'Imported by 1 file. Declared in .env.example, docker-compose.yml.'\n  }");
    expect(model).toContain("  meilisearch = resource 'Meilisearch' {\n    #search\n    technology 'image getmeili/meilisearch:v1.8'\n    description 'Declared in docker-compose.yml; no code found that uses it.'\n  }");
    expect(model).toContain("description 'Imported by 1 file. Declared in .env.example.'");
    const mapping = JSON.parse(await readFile(join(directory, ".pathlight", "pathlight.activity.json"), "utf8")) as { resources: unknown[] };
    expect(mapping.resources).toContainEqual({ element: "meilisearch", resource: "meilisearch", packages: [], declared: ["docker-compose.yml"] });
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.summary).toMatchObject({ unusedResources: 0, unsupported: 0, undeclared: 0 });
    expect(formatCheck(check)).toContain("· meilisearch  declared in docker-compose.yml; no code imports it");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("Helm and Terraform are read as declarations: chart dependencies, secrets named by their kind, images in values, Terraform blocks by type", () => {
  expect(chartFacts("apiVersion: v2\nname: shop\ndependencies:\n  - name: postgresql\n    version: 15.x\n  - name: redis\n  - name: common\n"))
    .toEqual([{ resource: "sql", engine: "postgresql", by: "chart postgresql" }, { resource: "redis", by: "chart redis" }]);
  const values = valuesFacts([
    "image:\n  registry: docker.io\n  repository: bitnami/rabbitmq\n  tag: 3",
    "secretNames:\n  cs_creds: ca-cs-credentials-secret\n  agentic_db_creds: ca-agentic-db-credentials-secret\n  external_redis_creds: ca-external-redis-credentials-secret\n  openidProxy_creds: x",
    "tls:\n  secretName: frontdoor-tls-cert\nsearch:\n  existingSecret: opensearch-admin\nreplicas: 3\n",
  ].join("\n"));
  expect(values.images).toEqual(["docker.io/bitnami/rabbitmq"]);
  expect(values.found.map(item => `${item.resource} ${item.by}`)).toEqual(["sql secret agentic_db_creds", "redis secret external_redis_creds", "oidc secret openidProxy_creds", "opensearch secret existingSecret"]);
  expect(templateFacts("spec:\n  containers:\n    - image: \"{{ .Values.image }}\"\n    - image: redis:7\n      env:\n        - name: REDIS_URL\n        - name: {{ .Values.x }}\n")).toEqual({ images: ["redis:7"], env: ["REDIS_URL"], programs: [] });
  expect(terraformFacts([
    'resource "aws_db_instance" "main" {\n  engine = "postgres"\n  tags = { a = "b" }\n}',
    'resource "aws_s3_bucket" "uploads" {}', 'resource "aws_vpc" "net" {}', 'resource "aws_iam_role" "app" {}',
    'module "cache" {\n  source = "terraform-aws-modules/elasticache/aws"\n}', 'resource "google_sql_database_instance" "db" {\n  database_version = "MYSQL_8_0"\n}',
  ].join("\n"))).toEqual([
    { resource: "sql", engine: "postgresql", by: "aws_db_instance main" }, { resource: "s3", by: "aws_s3_bucket uploads" },
    { resource: "sql", engine: "mysql", by: "google_sql_database_instance db" }, { resource: "redis", by: "module cache" },
  ]);
  // Networking and IAM are never read; what is declared joins the code as an image does: two engines with no code are two databases.
  const joined = withInfra([], [{ path: "main.tf", images: [], env: [], found: terraformFacts('resource "aws_db_instance" "a" {\n engine = "postgres"\n}\nresource "aws_sqs_queue" "jobs" {}') }]);
  expect(joined.map(item => [item.id, item.title, item.declared.map(entry => entry.by)])).toEqual([["postgresql", "PostgreSQL", ["aws_db_instance a"]], ["sqs", "Amazon SQS", ["aws_sqs_queue jobs"]]]);
});

test("a repository of only infrastructure is drawn as what it runs, and what only infrastructure declares is on the overview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-resources-only-"));
  try {
    await write(directory, { "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n", "README.md": "# ops\n" });
    const made = await Effect.runPromise(draftWorkspace(directory));
    expect([made.elements, made.resources]).toEqual([0, 2]);
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  view index {\n    title 'Resources'\n    description 'No code the scan reads: these are what the infrastructure files declare.'\n    include postgresql\n    include redis\n");
    expect(model).toContain("description 'Declared in docker-compose.yml.'");
    expect((await Effect.runPromise(listViews(directory))).views.map(view => String(view.id))).toEqual(["index"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const packages = await mkdtemp(join(tmpdir(), "pathlight-resources-declared-"));
  try {
    const three = (folder: string, text: string) => Object.fromEntries(["a", "b", "c"].map(name => [`${folder}/src/${name}.ts`, text]));
    await write(packages, {
      "web/package.json": '{"name":"web"}', "api/package.json": '{"name":"api"}', ...three("web", "export const w = 1;\n"), ...three("api", 'import pg from "pg";\nexport const a = pg;\n'),
      "docker-compose.yml": "services:\n  cache:\n    image: redis:7\n",
    });
    await Effect.runPromise(draftWorkspace(packages));
    const index = (await readFile(join(packages, ".pathlight", "pathlight.model.c4"), "utf8")).split("  view index {")[1]!.split("\n  }\n")[0]!;
    expect(index).toContain("include postgresql");
    expect(index).toContain("include redis");
  } finally {
    await rm(packages, { recursive: true, force: true });
  }
}, 60_000);

// Phase R2: what the infrastructure runs, with arrows to what each program uses.
const chart = {
  "Chart.yaml": "apiVersion: v2\nname: shopchart\nversion: 1.0.0\n",
  "values.yaml": "secretNames:\n  orders_db_creds: orders-db\n  mail_creds: smtp\n  tls_certs: certs\n",
  "templates/deployments/api-deployment.yaml": [
    "---", "apiVersion: apps/v1", "kind: Deployment", "metadata:", "{{ include \"labels\" . | indent 2 }}", "  name: shop-api", "spec:", "  template:", "    spec:", "      containers:",
    "        - name: api", "          image: {{ .Values.image }}", "          env:", "            - name: REDIS_URL", "      volumes:", "        - secret:", "            secretName: '{{ .Values.secretNames.orders_db_creds }}'",
    "        - secret:", "            secretName: '{{ .Values.secretNames.tls_certs }}'", "---", "apiVersion: v1", "kind: Service", "metadata:", "  name: shop-api",
  ].join("\n"),
  "templates/worker-deployment.yaml": "kind: Deployment\nmetadata:\n  name: {{ .Values.workerName }}\nspec:\n  template:\n    spec:\n      volumes:\n        - secret:\n            secretName: '{{ .Values.secretNames.mail_creds }}'\n",
  "templates/notes.yaml": "kind: ConfigMap\nmetadata:\n  name: notes\n",
};

test("a chart's workloads and a compose file's services are programs that use what their files name", () => {
  const compose = composeFacts([
    "services:", "  db:", "    image: postgres:16", "  cache:", "    image: redis:7", "  web:", "    image: acme/shop:1", "    depends_on:", "      db:", "        condition: service_healthy",
    "  worker:", "    image: acme/shop:1", "    depends_on: [cache]", "    links: ['db:database']", "  tools:", "    build: ./tools",
  ].join("\n"));
  // `db` and `cache` are resources, not programs; `tools` is built here and is no resource by its name, so it is a program.
  expect(compose.programs.map(item => [item.name, item.image ?? "", item.uses.map(use => `${use.engine ?? use.resource} ${use.by}`)])).toEqual([
    ["web", "acme/shop:1", ["postgresql depends_on db"]], ["worker", "acme/shop:1", ["redis depends_on cache", "postgresql links db"]], ["tools", "", []],
  ]);
  const files = [
    { path: "Chart.yaml", images: [], env: [], found: [], chart: "shopchart" },
    { path: "values.yaml", env: [], ...valuesFacts(chart["values.yaml"]) },
    { path: "templates/deployments/api-deployment.yaml", ...templateFacts(chart["templates/deployments/api-deployment.yaml"]) },
    { path: "templates/worker-deployment.yaml", ...templateFacts(chart["templates/worker-deployment.yaml"]) },
    { path: "templates/notes.yaml", ...templateFacts(chart["templates/notes.yaml"]) },
  ];
  // A workload's literal name, or its file's when the name is templated; a secret it reads leads where the chart's values say; a ConfigMap is no program.
  expect(programsOf(files).map(item => [item.title, item.name, item.kind, item.file, item.uses.map(use => `${use.resource} ${use.by}`)])).toEqual([
    ["shopchart", "shop-api", "Deployment", "templates/deployments/api-deployment.yaml", ["redis REDIS_URL", "sql secret orders_db_creds"]],
    ["shopchart", "worker", "Deployment", "templates/worker-deployment.yaml", ["mail secret mail_creds"]],
  ]);
});

test("a repository that is mostly infrastructure draws its programs with arrows, and check judges them by the files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-programs-"));
  try {
    await write(directory, chart);
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  element container\n");
    expect(model).toContain("  shop_api = container 'shop-api' {\n    description 'A Deployment in templates/deployments/api-deployment.yaml.'\n  }");
    expect(model).toContain("  shop_api -> sql 'secret orders_db_creds'\n");
    expect(model).toContain("  worker -> mail 'secret mail_creds'\n");
    // REDIS_URL alone declares no Redis, so there is no box for an arrow to reach.
    expect(model).not.toContain("redis");
    expect(model).toContain("  view index {\n    title 'shopchart'\n    include *\n");
    const mapping = JSON.parse(await readFile(join(directory, ".pathlight", "pathlight.activity.json"), "utf8")) as { mappings: unknown[]; programs: unknown[] };
    expect(mapping.mappings).toContainEqual({ glob: "templates/deployments/api-deployment.yaml", element: "shop_api" });
    expect(mapping.programs).toEqual([{ element: "shop_api", source: ".", name: "shop-api" }, { element: "worker", source: ".", name: "worker" }]);
    let check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.relationships.map(item => [item.source, item.target, item.status])).toEqual([["shop_api", "sql", "supported"], ["worker", "mail", "supported"]]);
    expect(formatCheck(check)).toContain("✓ shop_api → sql  “secret orders_db_creds”  1 name, e.g. templates/deployments/api-deployment.yaml → secret orders_db_creds");
    // The worker stops reading the mail secret and the API starts: one arrow loses its evidence, and a use has no arrow.
    await write(directory, { "templates/worker-deployment.yaml": chart["templates/worker-deployment.yaml"].replace("mail_creds", "tls_certs"),
      "templates/deployments/api-deployment.yaml": chart["templates/deployments/api-deployment.yaml"].replace("secretNames.tls_certs", "secretNames.mail_creds") });
    check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.relationships.find(item => item.source === "worker")!.status).toBe("unsupported");
    expect(formatCheck(check)).toContain("▲ worker → mail  “secret mail_creds”  its infrastructure no longer names it");
    expect(check.undeclared.map(item => `${item.source} → ${item.target}`)).toEqual(["shop_api → mail"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a compose file's programs are one box beside the code, those running one image a collection, and their cards say container", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-programs-compose-"));
  try {
    const service = (name: string) => [`  ${name}:`, "    image: ${APP_IMAGE}", "    depends_on: [cache]"];
    await write(directory, { "tool.py": "import os\n", "docker-compose.yml": ["services:", "  cache:", "    image: redis:7", ...service("web"), ...service("worker"), ...service("cron"), "  proxy:", "    image: nginx:1"].join("\n") });
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  docker_compose = package 'docker-compose' {\n    description 'Compose file: 4 services.'");
    expect(model).toContain("    app = collection 'app' {\n      description '3 programs that run the image ${APP_IMAGE}.'");
    expect(model).toContain("  docker_compose.app.web -> redis 'depends_on cache'\n");
    const screen = await run(process.execPath, [resolve("src/cli.ts"), "see", "docker_compose_components", "--workspace", directory, "--cols", "140", "--rows", "40"]);
    expect(screen).toMatch(/│ container +│[\s\S]*?│ proxy +│/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// Who uses a resource (plan phase-r3-who-uses-this.md): Enter on a resource opens a view of it and the boxes that lead to it, nothing else.
test("a resource opens the view of who uses it, in the terminal and the browser, with only the arrows into it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-who-uses-"));
  try {
    await write(directory, shop);
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  view kafka_users of kafka {\n    title 'Who uses Kafka'\n    description '1 component uses Kafka.'\n    include kafka\n    include orders\n    exclude * -> *\n    include orders -> kafka\n");
    const views = (await Effect.runPromise(listViews(directory))).views.map(view => String(view.id));
    expect(views).toEqual(expect.arrayContaining(["kafka_users", "postgresql_users", "s3_users"]));
    const screen = await run(process.execPath, [resolve("src/cli.ts"), "see", "index", "--workspace", directory, "--cols", "140", "--rows", "40", "--select", "kafka", "--keys", "Enter"]);
    expect(screen).toContain("pathlight / Who uses Kafka");
    expect(screen).toContain("Selected: kafka");
    expect(screen).toMatch(/│ orders +│/);
    expect(screen).not.toMatch(/│ web +│/);

    const web = await Effect.runPromise(startWebServer(await selectView(directory, "index"), { page: null, theme: "pathlight" }));
    try {
      const response = await fetch(`http://127.0.0.1:${web.port}/api/events?t=${web.token}&cols=140&rows=40&view=kafka_users`);
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const frame = (JSON.parse(new TextDecoder().decode(value).slice(6)) as { frame: Frame }).frame;
      expect(Object.keys(frame.cards).sort()).toEqual(["kafka", "orders"]);
      await reader.cancel();
    } finally { await web.stop(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("past the cap the users of a resource are drawn by the image they run, and a resource nothing uses opens no view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-who-uses-many-"));
  try {
    const service = (name: string, image: string) => [`  ${name}:`, `    image: ${image}`, "    depends_on: [cache]"];
    const many = [...Array.from({ length: 10 }, (_, index) => service(`snuba-${index}`, "${SNUBA_IMAGE}")), ...Array.from({ length: 9 }, (_, index) => service(`web-${index}`, "${WEB_IMAGE}"))].flat();
    await write(directory, { "tool.py": "import os\n", "docker-compose.yml": ["services:", "  cache:", "    image: redis:7", "  db:", "    image: postgres:16", ...many].join("\n") });
    await Effect.runPromise(draftWorkspace(directory));
    const model = await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8");
    expect(model).toContain("  view redis_users of redis {\n    title 'Who uses Redis'\n    description '19 programs use Redis. Programs that run one image are drawn as one box to fit.'\n    include redis\n    include docker_compose\n    include docker_compose.snuba\n    include docker_compose.web\n");
    expect(model).toContain("description 'Declared in docker-compose.yml; 19 programs name it.'");
    // Postgres is declared and nothing names it: its card stays as it was and Enter opens nothing.
    expect(model).not.toContain("postgresql_users");
    const views = (await Effect.runPromise(listViews(directory))).views.map(view => String(view.id));
    expect(views).toContain("redis_users");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
