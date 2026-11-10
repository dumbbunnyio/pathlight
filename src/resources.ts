import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { Effect } from "effect";
import infra from "./resources/infra.json";
import table from "./resources/imports.json";

/**
 * What the code talks to that is not code: databases, caches, queues, object stores, search, mail, identity providers, monitoring, AI providers and
 * other third-party APIs (plan phase-r-resources.md). Read from evidence the scan already has, the packages each file imports, through one table of data
 * (`resources/imports.json`), never guessed: a resource exists only where a file names a package that leads to it. An import that only names types, and
 * a file the draft leaves out (a test), is no evidence.
 */

export type ResourceKind = "database" | "cache" | "queue" | "storage" | "search" | "mail" | "identity" | "monitoring" | "ai" | "service";
export const resourceKinds: readonly ResourceKind[] = table.kinds as ResourceKind[];

export interface Resource {
  /** The table's id, or for a SQL database its engine when the code names exactly one (`postgresql`), else `sql`. */
  readonly id: string;
  /** What the overlay names it by (`resource:<id>`), as an element is named by its path. */
  readonly key: string;
  readonly title: string; readonly kind: ResourceKind;
  /** A SQL database (its schema files can be mapped to it). */
  readonly sql: boolean;
  /** The engines a SQL database's drivers name, when more than one could be meant. */
  readonly engines: readonly string[];
  /** The packages that lead to it, and every file that imports one (each with the packages it imports). */
  readonly packages: readonly string[];
  readonly files: readonly { readonly path: string; readonly packages: readonly string[] }[];
  /** What infrastructure files say of it (step 2): the file and what in it (`image postgres:16`, `POSTGRES_DB`). With no files, it is all there is. */
  readonly declared: readonly { readonly path: string; readonly by: string }[];
}

interface Entry { readonly match: string; readonly resource: string; readonly engine?: string }
const entries = new Map((table.packages as Entry[]).map(entry => [entry.match, entry]));
const definitions = table.resources as Record<string, { title: string; kind: ResourceKind }>;
const engineNames = table.engines as Record<string, string>;

/** The table's entry for a package as the scan names it: the package itself, or the nearest of its parent paths (`github.com/jackc/pgx/v5/pgxpool`). */
export const entryFor = (name: string): Entry | undefined => {
  for (let at = name; at; at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "") {
    const found = entries.get(at);
    if (found) return found;
  }
  return undefined;
};

const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * The resources a workspace's imports lead to. `scopeOf` says which package a file belongs to (its nearest manifest), or undefined for a file that is no
 * evidence (outside the picture, a test). A SQL database is judged per package: an ORM or `database/sql` names no engine, so it joins the engine its
 * package's drivers name when there is one, and stays "SQL database" (with every engine named) when there are several; drivers with no ORM beside them
 * are one database per engine. The same database in two packages is one box, named by what it is.
 */
export function resourcesOf(external: readonly { readonly from: string; readonly package: string; readonly kind: string }[], scopeOf: (path: string) => string | undefined): Resource[] {
  // Per resource id: file → packages. SQL evidence waits until each package's engines are known.
  const found = new Map<string, Map<string, Set<string>>>();
  const sql = new Map<string, { engines: Set<string>; uses: { path: string; name: string; engine?: string }[] }>();
  const take = (id: string, path: string, name: string) => {
    const files = found.get(id) ?? new Map<string, Set<string>>();
    files.set(path, (files.get(path) ?? new Set()).add(name));
    found.set(id, files);
  };
  const engines = new Map<string, Set<string>>(), relational = new Set<string>();
  for (const item of external) {
    if (item.kind === "type") continue;
    const scope = scopeOf(item.from);
    if (scope === undefined) continue;
    const entry = entryFor(item.package);
    if (!entry) continue;
    if (entry.resource !== "sql") { take(entry.resource, item.from, item.package); continue; }
    const here = sql.get(scope) ?? { engines: new Set<string>(), uses: [] };
    if (entry.engine) here.engines.add(entry.engine);
    here.uses.push({ path: item.from, name: item.package, ...(entry.engine ? { engine: entry.engine } : {}) });
    sql.set(scope, here);
  }
  for (const { engines: named, uses } of sql.values()) {
    const orm = uses.some(use => !use.engine);
    for (const use of uses) {
      const id = named.size === 1 ? [...named][0]! : orm || !use.engine ? "sql" : use.engine;
      take(id, use.path, use.name);
      relational.add(id);
      if (id === "sql") engines.set("sql", new Set([...engines.get("sql") ?? [], ...named]));
    }
  }
  // One relational box per workspace where the evidence allows it (decision 1): a generic box and one engine box in the whole workspace are that
  // engine (a Go `database/sql` package beside a `pgx` one); an engine box whose engine the generic box already lists joins it (Infisical: `pg`
  // in one package, `knex`, `pg` and `mysql2` in another).
  const generic = found.get("sql");
  if (generic) {
    const all = new Set([...sql.values()].flatMap(({ engines: named }) => [...named]));
    const fold = (from: string, into: string) => {
      const files = found.get(into) ?? new Map<string, Set<string>>();
      for (const [path, names] of found.get(from) ?? []) files.set(path, new Set([...files.get(path) ?? [], ...names]));
      found.set(into, files);
      found.delete(from);
      relational.add(into);
    };
    if (all.size === 1 && found.has([...all][0]!)) { fold("sql", [...all][0]!); engines.delete("sql"); }
    else for (const engine of engines.get("sql") ?? []) if (found.has(engine)) fold(engine, "sql");
  }
  return [...found].map(([id, files]) => {
    const definition = definitions[id] ?? { title: engineNames[id] ?? id, kind: "database" as const };
    const named = [...engines.get(id) ?? []].sort(byText);
    return {
      id, key: `resource:${id}`, title: definition.title, kind: definition.kind, sql: relational.has(id), engines: named.map(engine => engineNames[engine] ?? engine),
      packages: [...new Set([...files.values()].flatMap(names => [...names]))].sort(byText),
      files: [...files].map(([path, names]) => ({ path, packages: [...names].sort(byText) })).sort((a, b) => byText(a.path, b.path)), declared: [],
    };
  }).sort((a, b) => byText(a.id, b.id));
}

/**
 * One infrastructure file, as names only: the container images it runs, the environment names it lists, and what else declares a resource (step 3: a
 * Helm chart's dependency, a Helm value naming a secret by its kind, a Terraform resource or module). A secret's or a setting's value is never read.
 */
export interface InfraFile {
  readonly path: string; readonly images: readonly string[]; readonly env: readonly string[];
  readonly found?: readonly { readonly resource: string; readonly engine?: string; readonly by: string }[];
}

const composeFile = /(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/i;
const envExample = /(^|\/)(\.env\.(example|sample|template|dist|defaults)|(example|sample|template)\.env|\.env\.[^/]*\.(example|sample))$/i;
/** The files the developer's own inventory is in (step 2): compose files and the example environment, not under a test folder. */
export const isInfraFile = (path: string) => (composeFile.test(path) || envExample.test(path)) && !/(^|\/)(tests?|__tests__|e2e|fixtures)\//.test(path) && !path.startsWith(".pathlight/");

const envName = /^[A-Z][A-Z0-9_]*$/;
/** The names an example environment file sets (`NAME=` lines, `export NAME=`), never their values. */
export const envNames = (text: string) => [...new Set(text.split("\n").flatMap(line => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match && envName.test(match[1]!) ? [match[1]!] : [];
}))].sort(byText);

/** A compose file's images and environment names (list or map form, `${NAME}` references too). */
export const composeFacts = (text: string) => {
  const images = new Set<string>(), env = new Set<string>(), found: { resource: string; engine?: string; by: string }[] = [];
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(text); } catch { return { images: [], env: [], found }; }
  const services = parsed && typeof parsed === "object" ? (parsed as { services?: unknown }).services : undefined;
  for (const [name, service] of services && typeof services === "object" ? Object.entries(services) : []) {
    if (!service || typeof service !== "object") continue;
    const { image, environment, build } = service as { image?: unknown; environment?: unknown; build?: unknown };
    if (typeof image === "string") images.add(image.trim());
    // A service built here has no image to look up (Sentry's `clickhouse-self-hosted-local`): the developer's name for the service stands in.
    const known = typeof image === "string" && imageResource(image) !== undefined;
    const id = build !== undefined && !known ? imageResource(name) : undefined;
    if (id) found.push(asFound(id, `service ${name}, built here`));
    const names = Array.isArray(environment) ? environment.map(item => String(item).split("=")[0]!.trim()) : environment && typeof environment === "object" ? Object.keys(environment) : [];
    for (const name of names) if (envName.test(name)) env.add(name);
  }
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) env.add(match[1]!);
  return { images: [...images].sort(byText), env: [...env].sort(byText), found };
};

const charts = infra.charts as Record<string, string>, terraformTypes = infra.terraform as Record<string, string>, moduleWords = infra.modules as Record<string, string>;
const engineWords = infra.engines as Record<string, string>, secretWords = infra.secrets as Record<string, string>;
/** A table id that is a SQL engine becomes `sql` with that engine. */
const asFound = (id: string, by: string) => engineNames[id] ? { resource: "sql", engine: id, by } : { resource: id, by };
const words = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A Helm chart's `Chart.yaml`: its dependencies by chart name. */
export const chartFacts = (text: string) => {
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(text); } catch { return []; }
  const dependencies = parsed && typeof parsed === "object" ? (parsed as { dependencies?: unknown }).dependencies : undefined;
  return (Array.isArray(dependencies) ? dependencies : []).flatMap(item => {
    const name = item && typeof item === "object" ? String((item as { name?: unknown }).name ?? "") : "", id = charts[name];
    return id ? [asFound(id, `chart ${name}`)] : [];
  });
};

/**
 * A Helm values file: the images it names (`image: repo:tag`, or `repository` beside `registry`), and each value that names a secret or credentials
 * (its key says `secret`, `creds` or `credentials`) by a kind word in its key or name: `agentic_db_creds` is a database, `external_redis_creds` Redis.
 */
export const valuesFacts = (text: string) => {
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(text); } catch { return { images: [], found: [] }; }
  const images = new Set<string>(), found: { resource: string; engine?: string; by: string }[] = [];
  const walk = (value: unknown, path: string[], depth: number) => {
    if (depth > 24 || value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, path, depth + 1)); return; }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.repository === "string" && /image/i.test(path.at(-1) ?? "")) images.add([record.registry, record.repository].filter(part => typeof part === "string" && part).join("/"));
      for (const [key, inner] of Object.entries(record)) walk(inner, [...path, key], depth + 1);
      return;
    }
    const key = path.at(-1) ?? "";
    if (key === "image" && typeof value === "string") { images.add(value); return; }
    if (!/secret|creds|credential/i.test(path.slice(-2).join(" "))) return;
    const id = [...words(key), ...words(typeof value === "string" ? value : "")].map(word => secretWords[word]).find(Boolean);
    if (id) found.push(asFound(id, `secret ${key}`));
  };
  walk(parsed, [], 0);
  return { images: [...images].sort(byText), found };
};

/** A Helm template is Go templating, not YAML: only its literal `image:` lines and the environment names it sets (`- name: REDIS_URL`) are read. */
export const templateFacts = (text: string) => ({
  images: [...new Set([...text.matchAll(/^\s*(?:-\s*)?image:\s*["']?([^"'\s{]+)["']?\s*$/gm)].map(match => match[1]!))].sort(byText),
  env: [...new Set([...text.matchAll(/^\s*-?\s*name:\s*["']?([A-Z][A-Z0-9_]+)["']?\s*$/gm)].map(match => match[1]!))].sort(byText),
});

/**
 * Terraform, as block headers: each `resource "TYPE" "NAME"` whose type the table knows (a database's `engine = "…"` inside its block names its engine),
 * and each `module` whose `source` holds a known word (`terraform-aws-modules/rds/aws`). Nothing is evaluated: variables, counts and providers are not read.
 */
export const terraformFacts = (text: string) => {
  const found: { resource: string; engine?: string; by: string }[] = [];
  const body = (from: number) => {
    let depth = 0, at = text.indexOf("{", from);
    if (at < 0) return "";
    const start = at;
    for (; at < text.length; at++) { if (text[at] === "{") depth++; else if (text[at] === "}" && --depth === 0) break; }
    return text.slice(start, at);
  };
  for (const match of text.matchAll(/^\s*resource\s+"([A-Za-z0-9_]+)"\s+"([^"]+)"/gm)) {
    const id = terraformTypes[match[1]!];
    if (!id) continue;
    const engine = /^\s*engine\s*=\s*"([^"]+)"/m.exec(body(match.index!))?.[1] ?? /database_version\s*=\s*"([A-Z]+)/.exec(body(match.index!))?.[1];
    const named = engine ? engineWords[engine] : undefined;
    found.push(named ? { resource: "sql", engine: named, by: `${match[1]} ${match[2]}` } : asFound(id, `${match[1]} ${match[2]}`));
  }
  for (const match of text.matchAll(/^\s*module\s+"([^"]+)"/gm)) {
    const source = /^\s*source\s*=\s*"([^"]+)"/m.exec(body(match.index!))?.[1] ?? "";
    const id = source.split(/[/:]/).map(part => moduleWords[part]).find(Boolean);
    if (id) found.push(asFound(id, `module ${match[1]}`));
  }
  return found;
};

const chartFile = /(^|\/)Chart\.ya?ml$/, valuesFile = /(^|\/)values([.-][^/]*)?\.ya?ml$/i, templateFile = /(^|\/)templates\/[^/]+\.ya?ml$/i;

/** Reads the infrastructure files among `paths` (each at most 1 MB): compose, example environments, Helm charts and Terraform. */
export const readInfra = Effect.fn("Resources.infra")(function* (root: string, paths: readonly string[]) {
  const found: InfraFile[] = [];
  // A Helm chart is a folder with a Chart.yaml: its values and templates are read as Helm's, never as compose.
  const chartDirs = new Set(paths.filter(path => chartFile.test(path)).map(path => posix.dirname(path)));
  const inChart = (path: string) => chartDirs.has(posix.dirname(path)) || chartDirs.has(posix.dirname(posix.dirname(path)));
  const helm = (path: string) => chartFile.test(path) || (inChart(path) && (valuesFile.test(path) || templateFile.test(path)));
  for (const path of paths.filter(path => (isInfraFile(path) || helm(path) || /\.tf$/.test(path)) && !/(^|\/)(tests?|__tests__|e2e|fixtures|\.terraform)\//.test(path))) {
    const text = yield* Effect.tryPromise(async () => (await lstat(join(root, path))).size <= 1024 * 1024 ? await readFile(join(root, path), "utf8") : undefined).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (text === undefined) continue;
    if (chartFile.test(path)) found.push({ path, images: [], env: [], found: chartFacts(text) });
    else if (helm(path) && valuesFile.test(path)) found.push({ path, env: [], ...valuesFacts(text) });
    else if (helm(path)) found.push({ path, ...templateFacts(text) });
    else if (path.endsWith(".tf")) found.push({ path, images: [], env: [], found: terraformFacts(text) });
    else found.push(posix.basename(path).toLowerCase().includes("compose") && /\.ya?ml$/i.test(path) ? { path, ...composeFacts(text) } : { path, images: [], env: envNames(text) });
  }
  return found.filter(file => file.images.length || file.env.length || file.found?.length);
});

const images = infra.images as Record<string, string>;
const envRules = infra.env as { name: string; resource: string; engine?: string }[];
const declares = new Set(infra.declares);

/** The resource an image runs: its repository with the registry's `docker.io/` and `library/` and any tag or digest removed, then its last segment. */
export const imageResource = (image: string) => {
  const bare = image.replace(/@.*$/, "").replace(/:[^/:]*$/, "").replace(/^(docker\.io\/|index\.docker\.io\/)/, "").replace(/^library\//, "").toLowerCase();
  return images[bare] ?? images[bare.split("/").at(-1)!];
};
/** Evidence that a thing exists (an image, a chart, a secret, a Terraform block), as against an environment name, which is a setting. */
const declaring = (item: { by: string }) => !/^[A-Z][A-Z0-9_]*$/.test(item.by);
const envResource = (name: string) => envRules.find(rule => rule.name.endsWith("_") ? name.startsWith(rule.name) : name === rule.name);

/**
 * Joins what infrastructure files say with what the code imports (step 2). A file confirms a resource the code already reaches and cites itself; it
 * names a SQL database the code reaches only through an ORM or `database/sql` when every file that names an engine names the same one (an image
 * `postgres`, `POSTGRES_*`); and it adds a box the code never reaches only for the kinds `declares` lists (a datastore, a cache, a queue, object storage,
 * search, mail), and only when the file runs it (an image), marked as declared with no code found. An environment name alone, and an identity provider,
 * an API or monitoring that only a file names, add nothing: a setting is not evidence that this code calls it.
 */
export function withInfra(resources: readonly Resource[], files: readonly InfraFile[]): Resource[] {
  const said = new Map<string, { path: string; by: string }[]>(), engines = new Map<string, { path: string; by: string }[]>();
  const note = (map: Map<string, { path: string; by: string }[]>, id: string, path: string, by: string) => {
    const list = map.get(id) ?? [];
    if (!list.some(item => item.path === path && item.by === by)) list.push({ path, by });
    map.set(id, list);
  };
  for (const file of files) {
    for (const image of file.images) {
      const id = imageResource(image);
      if (!id) continue;
      if (engineNames[id]) note(engines, id, file.path, `image ${image}`); else note(said, id, file.path, `image ${image}`);
    }
    // A chart dependency, a secret named by its kind, a Terraform resource: each says the thing exists, as an image does.
    for (const item of file.found ?? []) {
      if (item.engine) note(engines, item.engine, file.path, item.by); else note(said, item.resource, file.path, item.by);
    }
    for (const name of file.env) {
      const rule = envResource(name);
      if (!rule) continue;
      if (rule.engine) note(engines, rule.engine, file.path, name); else note(said, rule.resource, file.path, name);
    }
  }
  const out = resources.map(item => ({ ...item, declared: [...item.declared] }));
  const relational = out.filter(item => item.sql);
  // An engine the files name: it names the one database the code reaches through an ORM, or confirms the database of that engine.
  const named = [...engines.keys()];
  for (const item of relational) {
    if (engines.has(item.id)) item.declared.push(...engines.get(item.id)!);
    else if (item.id === "sql" && item.engines.length) {
      for (const engine of named) if (item.engines.includes(engineNames[engine]!)) item.declared.push(...engines.get(engine)!);
    }
    // Only when the code names no engine itself: code that names two (Mealie's psycopg2 and sqlite3) supports both, whatever one compose file runs.
    else if (item.id === "sql" && named.length === 1 && !item.engines.length) {
      Object.assign(item, { title: engineNames[named[0]!]!, engines: [] });
      item.declared.push(...engines.get(named[0]!)!);
    }
    // `DATABASE_URL` and its kind name no engine: they confirm the one database there is.
    if (relational.length === 1) item.declared.push(...said.get("sql") ?? []);
  }
  for (const [id, list] of said) {
    if (id === "sql") continue;
    const found = out.find(item => item.id === id);
    if (found) { found.declared.push(...list); continue; }
    const definition = definitions[id];
    if (definition && declares.has(definition.kind) && list.some(declaring)) out.push({ id, key: `resource:${id}`, title: definition.title, kind: definition.kind, sql: false, engines: [], packages: [], files: [], declared: list });
  }
  // A database only the files declare (an engine's image, a Terraform database, a secret for one) when the code reaches none: one per engine, or one
  // "SQL database" when they name none.
  if (!relational.length) {
    for (const [id, list] of engines) if (list.some(declaring)) out.push({ id, key: `resource:${id}`, title: engineNames[id]!, kind: "database", sql: true, engines: [], packages: [], files: [], declared: list });
    const generic = said.get("sql") ?? [];
    if (!engines.size && generic.some(declaring)) out.push({ id: "sql", key: "resource:sql", title: definitions.sql!.title, kind: "database", sql: true, engines: [], packages: [], files: [], declared: generic });
  }
  for (const item of out) item.declared.sort((a, b) => byText(a.path, b.path) || byText(a.by, b.by));
  return out.sort((a, b) => byText(a.id, b.id));
}
