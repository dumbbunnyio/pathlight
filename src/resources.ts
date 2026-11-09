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

/** One infrastructure file, as names only: the container images it runs and the environment names it lists. A value is never read. */
export interface InfraFile { readonly path: string; readonly images: readonly string[]; readonly env: readonly string[] }

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
  const images = new Set<string>(), env = new Set<string>();
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(text); } catch { return { images: [], env: [] }; }
  const services = parsed && typeof parsed === "object" ? (parsed as { services?: unknown }).services : undefined;
  for (const service of services && typeof services === "object" ? Object.values(services) : []) {
    if (!service || typeof service !== "object") continue;
    const { image, environment } = service as { image?: unknown; environment?: unknown };
    if (typeof image === "string") images.add(image.trim());
    const names = Array.isArray(environment) ? environment.map(item => String(item).split("=")[0]!.trim()) : environment && typeof environment === "object" ? Object.keys(environment) : [];
    for (const name of names) if (envName.test(name)) env.add(name);
  }
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) env.add(match[1]!);
  return { images: [...images].sort(byText), env: [...env].sort(byText) };
};

/** Reads the infrastructure files among `paths` (each at most 1 MB). */
export const readInfra = Effect.fn("Resources.infra")(function* (root: string, paths: readonly string[]) {
  const found: InfraFile[] = [];
  for (const path of paths.filter(isInfraFile)) {
    const text = yield* Effect.tryPromise(async () => (await lstat(join(root, path))).size <= 1024 * 1024 ? await readFile(join(root, path), "utf8") : undefined).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (text === undefined) continue;
    found.push(posix.basename(path).toLowerCase().includes("compose") && /\.ya?ml$/i.test(path) ? { path, ...composeFacts(text) } : { path, images: [], env: envNames(text) });
  }
  return found;
});

const images = infra.images as Record<string, string>;
const envRules = infra.env as { name: string; resource: string; engine?: string }[];
const declares = new Set(infra.declares);

/** The resource an image runs: its repository with the registry's `docker.io/` and `library/` and any tag or digest removed, then its last segment. */
export const imageResource = (image: string) => {
  const bare = image.replace(/@.*$/, "").replace(/:[^/:]*$/, "").replace(/^(docker\.io\/|index\.docker\.io\/)/, "").replace(/^library\//, "").toLowerCase();
  return images[bare] ?? images[bare.split("/").at(-1)!];
};
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
    if (definition && declares.has(definition.kind) && list.some(item => item.by.startsWith("image "))) out.push({ id, key: `resource:${id}`, title: definition.title, kind: definition.kind, sql: false, engines: [], packages: [], files: [], declared: list });
  }
  // A database only the files run (an image of an engine) when the code reaches none.
  if (!relational.length) for (const [id, list] of engines) {
    if (!list.some(item => item.by.startsWith("image "))) continue;
    out.push({ id, key: `resource:${id}`, title: engineNames[id]!, kind: "database", sql: true, engines: [], packages: [], files: [], declared: list });
  }
  for (const item of out) item.declared.sort((a, b) => byText(a.path, b.path) || byText(a.by, b.by));
  return out.sort((a, b) => byText(a.id, b.id));
}
