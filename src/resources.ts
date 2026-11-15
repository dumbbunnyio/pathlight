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
/** A resource id that is a SQL database: the generic box or one named after its engine. */
export const isSqlResource = (id: string) => id === "sql" || engineNames[id] !== undefined;

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
  readonly found?: readonly Found[];
  /** A compose file's services that are themselves a resource (Phase 7): `db` runs PostgreSQL. */
  readonly services?: readonly Found[];
  /** A `Chart.yaml`'s chart name. */
  readonly chart?: string;
  /** The programs this file runs (Phase R2): a Helm template's workloads, a compose file's services that are not themselves a resource. */
  readonly programs?: readonly RawProgram[];
  /** A Dockerfile's names (Phase 7): what it copies in, what it builds, what it runs. */
  readonly dockerfile?: DockerFacts;
  /**
   * A file that runs things and is nothing else (Phase 7 step 3): a Procfile, a systemd unit, a plain Kubernetes manifest. Its processes are not R2's
   * programs (they never become boxes of the model); `services` holds the ones that are themselves a resource (a pod's `postgres:14` container).
   */
  readonly runner?: { readonly format: "procfile" | "systemd" | "kubernetes"; readonly processes: readonly RawProgram[] };
}

/** `name`: what the file calls the thing (a compose service, a chart dependency, a Terraform block's name), where it has one. */
export type Found = { readonly resource: string; readonly engine?: string; readonly by: string; readonly name?: string };
/** A program as one file says it: a template names the values it reads (`values` paths, joined to the chart's values later), a compose service its uses. */
export interface RawProgram { readonly name?: string; readonly kind: string; readonly image?: string; readonly uses: readonly Found[]; readonly values?: readonly string[]; readonly build?: Build; readonly command?: string }
/** A compose service's `build:`: the context folder and the Dockerfile, both as the compose file writes them (relative to its folder and to the context). */
export interface Build { readonly context: string; readonly dockerfile?: string }
/**
 * A program the infrastructure runs and what it uses, by the names its files give (Phase R2): `source` is the chart folder or the compose file that holds
 * it, `title` that holder's name, `file` the template it is defined in (a compose service has none of its own).
 */
export interface Program { readonly source: string; readonly title: string; readonly name: string; readonly kind: string; readonly image?: string; readonly file?: string; readonly uses: readonly Found[]; readonly build?: Build; readonly command?: string }

const composeFile = /(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/i;
const envExample = /(^|\/)(\.env\.(example|sample|template|dist|defaults)|(example|sample|template)\.env|\.env\.[^/]*\.(example|sample))$/i;
/** The files the developer's own inventory is in (step 2): compose files and the example environment, not under a test folder. */
export const isInfraFile = (path: string) => (composeFile.test(path) || envExample.test(path)) && !testFolder.test(path) && !path.startsWith(".pathlight/");

/** Folders whose infrastructure is for tests: `test/`, `e2e/`, `fixtures/`, and Sentry's `_integration-test/`. */
const testFolder = /(^|\/)(tests?|__tests__|e2e|fixtures|_?(integration|unit|e2e)[-_]tests?)\//;
const envName = /^[A-Z][A-Z0-9_]*$/;
/** The names an example environment file sets (`NAME=` lines, `export NAME=`), never their values. */
export const envNames = (text: string) => [...new Set(text.split("\n").flatMap(line => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match && envName.test(match[1]!) ? [match[1]!] : [];
}))].sort(byText);

/** A compose file's images and environment names (list or map form, `${NAME}` references too). */
export const composeFacts = (text: string) => {
  const images = new Set<string>(), env = new Set<string>(), found: { resource: string; engine?: string; by: string }[] = [], programs: RawProgram[] = [], running: Found[] = [];
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(text); } catch { return { images: [], env: [], found, programs, services: running }; }
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
  // Every service that is not itself a resource is a program; it uses the resources among the services it depends on or links to, and those its
  // environment names (`REDIS_HOST`). Which service is a resource is known only once every service is read.
  const record = services && typeof services === "object" ? services as Record<string, unknown> : {};
  const resourceOf = (name: string) => {
    const service = record[name];
    if (!service || typeof service !== "object") return undefined;
    const { image, build } = service as { image?: unknown; build?: unknown };
    return (typeof image === "string" ? imageResource(image) : undefined) ?? (build !== undefined ? imageResource(name) : undefined);
  };
  for (const [name, service] of Object.entries(record)) {
    const self = service && typeof service === "object" ? resourceOf(name) : undefined;
    if (self) { const image = (service as { image?: unknown }).image; running.push({ ...asFound(self, typeof image === "string" && imageResource(image) ? `image ${image.trim()}` : `service ${name}, built here`), name }); }
    if (!service || typeof service !== "object" || self) continue;
    const { image, environment, depends_on: dependsOn, links, build, command, entrypoint } = service as { image?: unknown; environment?: unknown; depends_on?: unknown; links?: unknown; build?: unknown; command?: unknown; entrypoint?: unknown };
    const uses: Found[] = [];
    const named = Array.isArray(dependsOn) ? dependsOn.map(String) : dependsOn && typeof dependsOn === "object" ? Object.keys(dependsOn) : [];
    for (const other of named) { const id = resourceOf(other); if (id) uses.push(asFound(id, `depends_on ${other}`)); }
    for (const link of Array.isArray(links) ? links.map(item => String(item).split(":")[0]!) : []) { const id = resourceOf(link); if (id) uses.push(asFound(id, `links ${link}`)); }
    const envList = Array.isArray(environment) ? environment.map(item => String(item).split("=")[0]!.trim()) : environment && typeof environment === "object" ? Object.keys(environment) : [];
    for (const variable of envList) { const rule = envName.test(variable) ? envResource(variable) : undefined; if (rule) uses.push({ resource: rule.resource, ...(rule.engine ? { engine: rule.engine } : {}), by: variable }); }
    const built = typeof build === "string" ? { context: build } : build && typeof build === "object" && typeof (build as { context?: unknown }).context === "string"
      ? { context: (build as { context: string }).context, ...(typeof (build as { dockerfile?: unknown }).dockerfile === "string" ? { dockerfile: (build as { dockerfile: string }).dockerfile } : {}) }
      : build && typeof build === "object" ? { context: ".", ...(typeof (build as { dockerfile?: unknown }).dockerfile === "string" ? { dockerfile: (build as { dockerfile: string }).dockerfile } : {}) } : undefined;
    // What the container runs: its entrypoint when it sets one, else its command (a string, or a list whose first item is the program).
    const run = [entrypoint, command].map(item => typeof item === "string" ? item.trim() : Array.isArray(item) ? item.map(String).join(" ").trim() : "").find(Boolean);
    programs.push({ name, kind: "service", ...(typeof image === "string" ? { image: image.trim() } : {}), uses, ...(built ? { build: built } : {}), ...(run ? { command: run } : {}) });
  }
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) env.add(match[1]!);
  return { images: [...images].sort(byText), env: [...env].sort(byText), found, programs, services: running };
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
    return id ? [{ ...asFound(id, `chart ${name}`), name }] : [];
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
  programs: workloads(text),
});

/**
 * The workloads a Helm template defines (Phase R2): each document of a workload kind, its literal `metadata.name` (none when the name is templated), its
 * literal images, the environment names it sets (`DATABASE_URL`) and the values it reads (`.Values.secretNames.mailserver_creds`), which the chart's own
 * values lead to resources.
 */
const workloads = (text: string): RawProgram[] => text.split(/^---\s*$/m).flatMap(doc => {
  const kind = /^kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*$/m.exec(doc)?.[1];
  if (!kind) return [];
  // Between `metadata:` and `spec:`, past the template lines (`{{ include … }}`) that sit at the start of a line.
  const start = /^metadata:\s*$/m.exec(doc), end = /^spec:\s*$/m.exec(doc);
  const metadata = start ? doc.slice(start.index, end && end.index > start.index ? end.index : undefined) : "";
  const name = /^ {2}name:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$/m.exec(metadata)?.[1];
  const uses: Found[] = [];
  for (const image of new Set([...doc.matchAll(/^\s*(?:-\s*)?image:\s*["']?([^"'\s{]+)["']?\s*$/gm)].map(match => match[1]!))) { const id = imageResource(image); if (id) uses.push(asFound(id, `image ${image}`)); }
  for (const variable of new Set([...doc.matchAll(/^\s*-?\s*name:\s*["']?([A-Z][A-Z0-9_]+)["']?\s*$/gm)].map(match => match[1]!))) {
    const rule = envResource(variable);
    if (rule) uses.push({ resource: rule.resource, ...(rule.engine ? { engine: rule.engine } : {}), by: variable });
  }
  const values = [...new Set([...doc.matchAll(/\.Values\.([A-Za-z0-9_.]+)/g)].map(match => match[1]!.replace(/\.$/, "")))].sort(byText);
  return [{ ...(name ? { name } : {}), kind, uses, values }];
});

/**
 * The programs the infrastructure runs (Phase R2). A chart's workloads read its values by path: a value path whose last key is a secret the chart's
 * values lead to a resource (`secretNames.mailserver_creds` → mail), or whose first key is a chart dependency (`postgresql.auth`), is a use. A workload
 * with a templated name is named by its file (`rest-deployment.yaml` → `rest`).
 */
export function programsOf(files: readonly InfraFile[]): Program[] {
  const charts = files.filter(file => file.chart !== undefined).map(file => ({ dir: posix.dirname(file.path), title: file.chart!, found: file.found ?? [] }));
  const chartOf = (path: string) => charts.filter(chart => chart.dir === "." || path.startsWith(`${chart.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const programs: Program[] = [];
  for (const file of files) {
    if (!file.programs?.length) continue;
    const chart = file.programs.some(item => item.values) ? chartOf(file.path) : undefined;
    if (file.programs.some(item => item.values) && !chart) continue;
    const secrets = new Map<string, Found[]>(), dependencies = new Map<string, Found>();
    if (chart) {
      for (const other of files.filter(candidate => chartOf(candidate.path) === chart && valuesFile.test(candidate.path))) {
        for (const item of other.found ?? []) if (item.by.startsWith("secret ")) secrets.set(item.by.slice(7), [...secrets.get(item.by.slice(7)) ?? [], item]);
      }
      for (const item of chart.found) if (item.by.startsWith("chart ")) dependencies.set(item.by.slice(6), item);
    }
    for (const item of file.programs) {
      const uses = [...item.uses];
      for (const path of item.values ?? []) {
        const keys = path.split(".");
        for (const found of secrets.get(keys.at(-1)!) ?? []) uses.push({ ...found, by: `secret ${keys.at(-1)}` });
        const dependency = dependencies.get(keys[0]!);
        if (dependency) uses.push({ ...dependency, by: `values ${keys[0]}` });
      }
      const name = item.name ?? posix.basename(file.path).replace(/\.ya?ml$/i, "").replace(/-(deployment|statefulset|daemonset|cronjob|job)$/i, "");
      const seen = new Set<string>();
      programs.push({
        source: chart ? chart.dir : file.path, title: chart ? chart.title : file.path === posix.basename(file.path) ? posix.basename(file.path).replace(/\.ya?ml$/i, "") : posix.dirname(file.path).split("/").at(-1)!,
        name, kind: item.kind, ...(item.image ? { image: item.image } : {}), ...(chart ? { file: file.path } : {}), ...(item.build ? { build: item.build } : {}), ...(item.command ? { command: item.command } : {}),
        uses: uses.filter(use => { const key = `${use.resource}\0${use.engine ?? ""}\0${use.by}`; return !seen.has(key) && Boolean(seen.add(key)); }),
      });
    }
  }
  return programs.sort((a, b) => byText(a.source, b.source) || byText(a.name, b.name));
}

/**
 * Terraform, as block headers: each `resource "TYPE" "NAME"` whose type the table knows (a database's `engine = "…"` inside its block names its engine),
 * and each `module` whose `source` holds a known word (`terraform-aws-modules/rds/aws`). Nothing is evaluated: variables, counts and providers are not read.
 */
export const terraformFacts = (text: string) => {
  const found: Found[] = [];
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
    found.push({ ...(named ? { resource: "sql", engine: named, by: `${match[1]} ${match[2]}` } : asFound(id, `${match[1]} ${match[2]}`)), name: match[2]! });
  }
  for (const match of text.matchAll(/^\s*module\s+"([^"]+)"/gm)) {
    const source = /^\s*source\s*=\s*"([^"]+)"/m.exec(body(match.index!))?.[1] ?? "";
    const id = source.split(/[/:]/).map(part => moduleWords[part]).find(Boolean);
    if (id) found.push({ ...asFound(id, `module ${match[1]}`), name: match[1]! });
  }
  return found;
};

/** What a Dockerfile says, by name (Phase 7): the context paths it copies in, the Cargo packages and binaries and the Go paths it builds, what it runs. */
export interface DockerFacts { readonly copies: readonly string[]; readonly cargo: readonly { readonly bin?: string; readonly package?: string }[]; readonly go: readonly string[]; readonly command?: string }

/** A Dockerfile, as instructions: line continuations joined, comments dropped. `COPY --from` copies from a stage, not from the context; `ADD` of a URL neither. */
export const dockerfileFacts = (text: string): DockerFacts => {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const copies = new Set<string>(), go = new Set<string>(), cargo: { bin?: string; package?: string }[] = [];
  let entrypoint: string | undefined, cmd: string | undefined;
  const argsOf = (rest: string) => {
    if (rest.startsWith("[")) { try { const list = JSON.parse(rest) as unknown; if (Array.isArray(list)) return list.map(String); } catch { /* shell form below */ } }
    return rest.split(/\s+/).filter(Boolean);
  };
  for (const line of lines) {
    const match = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const instruction = match[1]!.toUpperCase(), rest = match[2]!;
    if (instruction === "COPY" || instruction === "ADD") {
      const args = argsOf(rest);
      if (args.some(arg => arg.startsWith("--from"))) continue;
      const paths = args.filter(arg => !arg.startsWith("--"));
      for (const source of paths.slice(0, -1)) if (!/^[a-z]+:\/\//i.test(source)) copies.add(source);
    } else if (instruction === "RUN") {
      for (const part of rest.split(/&&|;|\|\|/)) {
        const words = part.trim().split(/\s+/);
        if (words[0] === "cargo" && words[1] === "build") {
          for (let at = 2; at < words.length; at++) {
            if (words[at] === "--bin" && words[at + 1]) cargo.push({ bin: words[++at]! });
            else if ((words[at] === "-p" || words[at] === "--package") && words[at + 1]) cargo.push({ package: words[++at]! });
            else if (/^--(bin|package)=/.test(words[at]!)) cargo.push(words[at]!.startsWith("--bin") ? { bin: words[at]!.slice(6) } : { package: words[at]!.slice(10) });
          }
        } else if (words[0] === "go" && words[1] === "build") {
          for (let at = 2; at < words.length; at++) {
            if (words[at] === "-o" || words[at] === "-ldflags" || words[at] === "-tags") { at++; continue; }
            if (!words[at]!.startsWith("-") && /^\.(\/|$)/.test(words[at]!)) go.add(words[at]!.replace(/\/\.\.\.$/, ""));
          }
        }
      }
    } else if (instruction === "FROM") {
      // A new stage: what an earlier one runs is not what the image runs.
      entrypoint = undefined; cmd = undefined;
    } else if (instruction === "CMD" || instruction === "ENTRYPOINT") {
      const said = argsOf(rest).join(" ").trim();
      if (instruction === "ENTRYPOINT") entrypoint = said || undefined; else cmd = said || undefined;
    }
  }
  // What the last stage runs: its entrypoint, which a command then only passes arguments to, else its command.
  const command = entrypoint ?? cmd;
  return { copies: [...copies], cargo, go: [...go], ...(command ? { command } : {}) };
};
const dockerfile = /(^|\/)([^/]*\.)?Dockerfile(\.[^/]*)?$/i;

/** A Procfile: one process per `name: command` line. */
export const procfileFacts = (text: string): RawProgram[] => text.split("\n").flatMap(line => {
  const match = /^([A-Za-z0-9_-]+):\s*(\S.*)$/.exec(line.trim());
  return match && !line.trimStart().startsWith("#") ? [{ name: match[1]!, kind: "process", uses: [], command: match[2]!.trim() }] : [];
});

/**
 * A systemd service unit: the unit, named by its file, runs its `[Service]` section's `ExecStart` (without the `-`, `@`, `+`, `!` prefixes). `After=`
 * only orders units: a unit it names is not run by this one.
 */
export const systemdFacts = (text: string, path: string): RawProgram[] => {
  let section = "", command: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) { section = line; continue; }
    const match = section === "[Service]" ? /^ExecStart\s*=\s*[-@+!:]*\s*(\S.*)$/.exec(line) : null;
    if (match) command ??= match[1]!.trim();
  }
  return command ? [{ name: posix.basename(path).replace(/\.service$/, ""), kind: "unit", uses: [], command }] : [];
};

const workloadKinds = /^kind:\s*["']?(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod)["']?\s*$/m;
/**
 * A plain Kubernetes manifest (not a Helm template): each workload's pod containers (not its init containers). A container whose image is a resource
 * is that resource; any other is a process with its image and, when it sets one, its `command` (its `args` alone do not name the program).
 */
export const kubernetesFacts = (text: string) => {
  const containers: { workload: string; kind: string; container: Record<string, unknown> }[] = [];
  for (const doc of text.split(/^---\s*$/m)) {
    if (!workloadKinds.test(doc)) continue;
    let parsed: unknown;
    try { parsed = Bun.YAML.parse(doc); } catch { continue; }
    const record = parsed as { kind?: unknown; metadata?: { name?: unknown }; spec?: Record<string, unknown> } | null;
    const kind = typeof record?.kind === "string" ? record.kind : "", workload = typeof record?.metadata?.name === "string" ? record.metadata.name : "";
    const spec = record?.spec;
    const pod = (kind === "Pod" ? spec : kind === "CronJob" ? (spec?.jobTemplate as { spec?: { template?: { spec?: unknown } } } | undefined)?.spec?.template?.spec
      : (spec?.template as { spec?: unknown } | undefined)?.spec) as { containers?: unknown } | undefined;
    for (const container of Array.isArray(pod?.containers) ? pod.containers as unknown[] : []) {
      if (container && typeof container === "object" && typeof (container as { name?: unknown }).name === "string" && (container as { name: string }).name) containers.push({ workload, kind, container: container as Record<string, unknown> });
    }
  }
  const images: string[] = [], env: string[] = [], services: Found[] = [], processes: RawProgram[] = [];
  for (const { workload, kind, container } of containers) {
    const { image, command, args, env: variables } = container as { image?: unknown; command?: unknown; args?: unknown; env?: unknown };
    // A container is named by itself unless another workload in the file has one of the same name: then `workload/container`, so each keeps its key.
    const own = container.name as string;
    const name = workload && containers.some(other => other.container !== container && other.container.name === own) ? `${workload}/${own}` : own;
    const names = (Array.isArray(variables) ? variables : []).map(item => item && typeof item === "object" ? String((item as { name?: unknown }).name ?? "") : "").filter(variable => envName.test(variable));
    env.push(...names);
    const id = typeof image === "string" ? imageResource(image) : undefined;
    if (typeof image === "string") images.push(image.trim());
    if (id) { services.push({ ...asFound(id, `image ${String(image).trim()}`), name }); continue; }
    const uses: Found[] = [];
    for (const variable of names) { const rule = envResource(variable); if (rule) uses.push({ resource: rule.resource, ...(rule.engine ? { engine: rule.engine } : {}), by: variable }); }
    const run = Array.isArray(command) && command.length ? [...command, ...Array.isArray(args) ? args : []].map(String).join(" ") : undefined;
    processes.push({ name, kind, ...(typeof image === "string" ? { image: image.trim() } : {}), uses, ...(run ? { command: run } : {}) });
  }
  return { images: [...new Set(images)].sort(byText), env: [...new Set(env)].sort(byText), services, processes };
};

const procfile = /(^|\/)Procfile(\.[^/]+)?$/;
const chartFile = /(^|\/)Chart\.ya?ml$/, valuesFile = /(^|\/)values([.-][^/]*)?\.ya?ml$/i, templateFile = /(^|\/)templates\/.+\.ya?ml$/i;

/** Reads the infrastructure files among `paths` (each at most 1 MB): compose, example environments, Helm charts and Terraform. */
export const readInfra = Effect.fn("Resources.infra")(function* (root: string, paths: readonly string[]) {
  const found: InfraFile[] = [];
  // A Helm chart is a folder with a Chart.yaml: its values and templates are read as Helm's, never as compose.
  const chartDirs = new Set(paths.filter(path => chartFile.test(path)).map(path => posix.dirname(path)));
  // Values sit beside Chart.yaml; templates anywhere under its `templates/` (Cognos keeps them in `templates/deployments/`).
  const inChart = (path: string) => chartDirs.has(posix.dirname(path)) || [...chartDirs].some(dir => path.startsWith(dir === "." ? "templates/" : `${dir}/templates/`));
  const helm = (path: string) => chartFile.test(path) || (inChart(path) && (valuesFile.test(path) || templateFile.test(path)));
  // Other YAML is read only for what its text shows first: a compose file in a folder named for compose (Miniflux's `contrib/docker-compose/basic.yml`),
  // a Kubernetes workload.
  const yaml = (path: string) => /\.ya?ml$/i.test(path) && !isInfraFile(path) && !helm(path) && !inChart(path) && !/(^|\/)\.github\//.test(path);
  const read = (path: string) => isInfraFile(path) || helm(path) || /\.tf$/.test(path) || dockerfile.test(path) || procfile.test(path) || path.endsWith(".service") || yaml(path);
  for (const path of paths.filter(path => read(path) && !testFolder.test(path) && !/(^|\/)\.terraform\//.test(path))) {
    const text = yield* Effect.tryPromise(async () => (await lstat(join(root, path))).size <= 1024 * 1024 ? await readFile(join(root, path), "utf8") : undefined).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (text === undefined) continue;
    if (chartFile.test(path)) found.push({ path, images: [], env: [], found: chartFacts(text), chart: chartName(text) ?? posix.basename(posix.dirname(path)) });
    else if (helm(path) && valuesFile.test(path)) found.push({ path, env: [], ...valuesFacts(text) });
    else if (helm(path)) found.push({ path, ...templateFacts(text) });
    else if (path.endsWith(".tf")) found.push({ path, images: [], env: [], found: terraformFacts(text) });
    // A Dockerfile's base images are not what this repository runs: only its names are kept, for the tie.
    else if (dockerfile.test(path)) found.push({ path, images: [], env: [], dockerfile: dockerfileFacts(text) });
    else if (procfile.test(path)) found.push({ path, images: [], env: [], runner: { format: "procfile", processes: procfileFacts(text) } });
    else if (path.endsWith(".service")) found.push({ path, images: [], env: [], runner: { format: "systemd", processes: systemdFacts(text, path) } });
    else if (yaml(path)) {
      if (/(^|\/)[^/]*compose[^/]*\/[^/]+$/i.test(path) && /^services:\s*$/m.test(text)) found.push({ path, ...composeFacts(text) });
      else if (workloadKinds.test(text) && /^apiVersion:/m.test(text)) {
        const { services, processes, ...facts } = kubernetesFacts(text);
        found.push({ path, ...facts, services, runner: { format: "kubernetes", processes } });
      }
    }
    else found.push(posix.basename(path).toLowerCase().includes("compose") && /\.ya?ml$/i.test(path) ? { path, ...composeFacts(text) } : { path, images: [], env: envNames(text) });
  }
  return found.filter(file => file.images.length || file.env.length || file.found?.length || file.chart !== undefined || file.programs?.length || file.dockerfile
    || file.runner && (file.runner.processes.length || file.services?.length));
});

/**
 * Where something runs (Phase 7): a compose file, a Helm chart (its folder), a folder of Terraform files, a Procfile, a systemd unit or a plain
 * Kubernetes manifest, with the resources it runs, by name.
 */
export interface Target {
  readonly path: string; readonly format: "compose" | "chart" | "terraform" | "procfile" | "systemd" | "kubernetes"; readonly runs: readonly (Found & { readonly name: string })[];
  /** The services that are not a resource (a compose service, a chart's workload), with what says what they run: an image, a `build:`, a command. */
  readonly services: readonly Program[];
}

/**
 * Not where the product runs: an editor's container (`.devcontainer/`), a compose file whose name says it is for tests (`docker-compose.e2e-dbs.yml`),
 * and a Terraform module's definition (a folder under `modules/`: what it declares runs where it is called from, which block headers do not say).
 */
const notWhereItRuns = (path: string) => /(^|\/)\.devcontainer\//.test(path) || (path.endsWith(".tf") ? /(^|\/)modules\//.test(path)
  : posix.basename(path).toLowerCase().split(/[^a-z0-9]+/).some(word => /^(tests?|testing|integration|e2e|bdd|ci)$/.test(word)));

/**
 * The targets among the infrastructure files, each with what it runs that is a resource: a compose file's services whose image is one; a chart's
 * dependencies and the images its values and templates name (one per resource: a chart says what it brings, not how many pods); a Terraform folder's
 * blocks. A secret or an environment name says a thing is used, not that this file runs it. A target that runs nothing at all is left out; the draft
 * decides which of the rest is a frame (one that runs a resource on the map or the repository's own code).
 */
export function targetsOf(files: readonly InfraFile[]): Target[] {
  const targets: Target[] = [];
  const programs = programsOf(files), servicesOf = (source: string) => programs.filter(item => item.source === source);
  const charts = files.filter(file => file.chart !== undefined).map(file => posix.dirname(file.path));
  const chartOf = (path: string) => charts.filter(dir => dir === "." || path.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0];
  const byChart = new Map<string, (Found & { name: string })[]>(), byFolder = new Map<string, (Found & { name: string })[]>();
  const imageName = (image: string) => image.replace(/@.*$/, "").replace(/:[^/:]*$/, "").split("/").at(-1)!;
  for (const file of files) {
    if (notWhereItRuns(file.path)) continue;
    if (file.runner) {
      const title = posix.basename(file.path);
      const services = file.runner.processes.map(item => ({ source: file.path, title, name: item.name!, kind: item.kind, ...(item.image ? { image: item.image } : {}), uses: item.uses, ...(item.command ? { command: item.command } : {}) }));
      if (services.length || file.services?.length) targets.push({ path: file.path, format: file.runner.format, runs: (file.services ?? []).map(item => ({ ...item, name: item.name! })), services });
      continue;
    }
    if (file.services) {
      if (file.services.length || file.programs?.length) targets.push({ path: file.path, format: "compose", runs: file.services.map(item => ({ ...item, name: item.name! })), services: servicesOf(file.path) });
      continue;
    }
    if (file.path.endsWith(".tf")) {
      const folder = posix.dirname(file.path), list = byFolder.get(folder) ?? [];
      for (const item of file.found ?? []) list.push({ ...item, name: item.name ?? item.by });
      byFolder.set(folder, list);
      continue;
    }
    const chart = chartOf(file.path);
    if (chart === undefined) continue;
    const list = byChart.get(chart) ?? [];
    for (const item of file.found ?? []) if (item.by.startsWith("chart ")) list.push({ ...item, name: item.name ?? item.by.slice(6) });
    for (const image of file.images) { const id = imageResource(image); if (id) list.push({ ...asFound(id, `image ${image}`), name: imageName(image) }); }
    byChart.set(chart, list);
  }
  // A chart names a resource once, a dependency before an image.
  for (const [path, list] of byChart) {
    const seen = new Set<string>(), runs = list.sort((a, b) => Number(b.by.startsWith("chart ")) - Number(a.by.startsWith("chart "))).filter(item => { const key = `${item.resource}\0${item.engine ?? ""}`; return !seen.has(key) && Boolean(seen.add(key)); });
    // A workload named for a resource the chart runs is that resource (Infisical nkp's `redis`, whose image is a values path to `valkey/valkey`).
    const services = servicesOf(path).filter(item => {
      const id = imageResource(item.name), self = id ? asFound(id, "") : undefined;
      return !self || !runs.some(run => run.resource === self.resource && (run.engine ?? "") === (self.engine ?? ""));
    });
    if (runs.length || services.length) targets.push({ path, format: "chart", runs, services });
  }
  for (const [path, runs] of byFolder) if (runs.length) targets.push({ path, format: "terraform", runs, services: [] });
  return targets.sort((a, b) => byText(a.path, b.path));
}

const chartName = (text: string) => {
  try { const parsed = Bun.YAML.parse(text) as { name?: unknown } | null; return typeof parsed?.name === "string" && parsed.name ? parsed.name : undefined; } catch { return undefined; }
};

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
