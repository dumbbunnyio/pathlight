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
      files: [...files].map(([path, names]) => ({ path, packages: [...names].sort(byText) })).sort((a, b) => byText(a.path, b.path)),
    };
  }).sort((a, b) => byText(a.id, b.id));
}
