import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { failure, io, json, type OperationError } from "./effects";
import { run } from "./process";
import { importsOf, type ImportKind } from "./scan-imports";

const Path = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Line = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const Kind = Schema.Literals(["import", "type", "reexport", "dynamic", "require"]);

/**
 * What a static read of the source says about a workspace: files, the imports between them, the packages they use,
 * and an honest account of what could not be read. Nothing here is observed at run time, and the output carries no
 * dates or absolute paths, so scanning the same tree twice gives the same text.
 */
export const Scan = Schema.Struct({
  version: Schema.Literal(1),
  basis: Schema.Literal("static"),
  root: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Path, language: Schema.Literals(["typescript", "javascript"]), lines: Count })),
  // Imports that resolve to a file in this workspace; `line` is where the statement starts in `from`.
  imports: Schema.Array(Schema.Struct({ from: Path, to: Path, line: Line, kind: Kind, specifier: Schema.String })),
  // Packages outside the workspace (and `node:` or `bun:` built-ins), once per importing file.
  external: Schema.Array(Schema.Struct({ from: Path, package: Schema.String, line: Line, kind: Kind })),
  // Imports that look like they point into the workspace but did not resolve to a file.
  unresolved: Schema.Array(Schema.Struct({ from: Path, specifier: Schema.String, line: Line, kind: Kind,
    reason: Schema.Literals(["not-found", "alias-not-configured", "package-entry-not-found"]) })),
  coverage: Schema.Struct({
    listing: Schema.Literals(["git", "walk"]), files: Count, imports: Count, external: Count, unresolved: Count,
    // Source files that were listed but not read: unreadable, not regular files, or over the size limit.
    skipped: Count,
    // Languages present in the workspace that this scan does not read, so their dependencies are absent.
    unscanned: Schema.Array(Schema.Struct({ extension: Schema.String, files: Count })),
  }),
});
export interface Scan extends Schema.Schema.Type<typeof Scan> {}

export const readScan = Effect.fn("Scan.read")(function* (path: string) {
  const text = yield* io("Scan.readFile", () => readFile(path, "utf8"));
  return yield* Schema.decodeUnknownEffect(Scan, { onExcessProperty: "error" })(yield* json(text));
});

const languages: Record<string, "typescript" | "javascript"> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
};
const sourceExtensions = Object.keys(languages);
// Languages that carry imports but are not read by this scan (a .vue or .svelte file holds TypeScript inside markup).
const unscannedExtensions = new Set([".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php", ".cs", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm",
  ".scala", ".dart", ".zig", ".ex", ".exs", ".lua", ".vue", ".svelte", ".astro"]);
const jsToTs: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const excludedDirectories = new Set([".git", ".cache", "node_modules"]);
const limits = { entries: 50_000, bytes: 2 * 1024 * 1024 };

const extension = (path: string) => posix.extname(path);

/** The file a path names, trying what TypeScript and Node do: the exact file, `.js` for `.ts`, an added extension, then a directory index. */
function resolveFile(files: ReadonlySet<string>, base: string): string | undefined {
  if (base.startsWith("../") || base === "..") return undefined;
  if (files.has(base)) return base;
  const ext = extension(base), stem = base.slice(0, base.length - ext.length);
  for (const alternative of jsToTs[ext] ?? []) if (files.has(stem + alternative)) return stem + alternative;
  for (const added of sourceExtensions) if (files.has(base + added)) return base + added;
  for (const added of sourceExtensions) if (files.has(`${base}/index${added}`)) return `${base}/index${added}`;
  return undefined;
}

/** JSON with comments and trailing commas, as tsconfig files are written. */
const relaxedJson = (text: string) => {
  let out = "", index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1); index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") { while (index < text.length && text[index] !== "\n") index++; }
    else if (char === "/" && text[index + 1] === "*") { const end = text.indexOf("*/", index + 2); index = end < 0 ? text.length : end + 2; }
    else { out += char; index++; }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};

interface Alias { readonly directory: string; readonly baseUrl: string | undefined; readonly paths: Record<string, readonly string[]> }
interface WorkspacePackage { readonly name: string; readonly directory: string; readonly entries: readonly string[]; readonly subpaths: ReadonlyMap<string, readonly string[]> }

// The files a package.json `exports` value (or `main`, `module`, `types`) points at, whatever condition names it nests them under.
const targetsOf = (value: unknown): string[] => typeof value === "string" ? [value]
  : value && typeof value === "object" ? ["import", "module", "default", "types", "require"].flatMap(key => targetsOf((value as Record<string, unknown>)[key])) : [];

const packageEntries = (manifest: Record<string, unknown>) => {
  const exported = manifest.exports;
  const root = exported && typeof exported === "object" && "." in exported ? (exported as Record<string, unknown>)["."] : exported;
  return [...targetsOf(root), ...["module", "main", "types"].flatMap(key => targetsOf(manifest[key]))];
};

const packageSubpaths = (manifest: Record<string, unknown>) => new Map(
  Object.entries(manifest.exports && typeof manifest.exports === "object" ? manifest.exports : {})
    .filter(([key]) => key.startsWith("./") && !key.includes("*")).map(([key, value]) => [key.slice(2), targetsOf(value)] as const));

export const listFiles = Effect.fn("Scan.list")(function* (root: string) {
  const ignoredPath = (path: string) => /[\x00-\x1f\x7f]/.test(path);
  const tooMany = () => failure("Scan.list", `The workspace lists more than ${limits.entries} files. Scan a smaller directory with --workspace.`);
  const tracked = yield* run("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).pipe(
    Effect.map(output => output.split("\0").filter(path => path && !ignoredPath(path))), Effect.option);
  if (tracked._tag === "Some") {
    if (tracked.value.length > limits.entries) return yield* Effect.fail(tooMany());
    return { listing: "git" as const, paths: [...new Set(tracked.value)].sort() };
  }
  const found: string[] = [];
  const walk = (directory: string): Effect.Effect<void, OperationError> => Effect.gen(function* () {
    for (const entry of yield* io("Scan.entries", () => readdir(join(root, directory), { withFileTypes: true }))) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (found.length >= limits.entries) return yield* Effect.fail(tooMany());
      if (ignoredPath(path)) continue;
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) yield* walk(path);
      else if (entry.isFile()) found.push(path);
    }
  });
  yield* walk("");
  return { listing: "walk" as const, paths: found.sort() };
});

const readText = (root: string, path: string) => io("Scan.read", async () => {
  const info = await lstat(join(root, path));
  if (!info.isFile() || info.size > limits.bytes) return undefined;
  return await readFile(join(root, path), "utf8");
}).pipe(Effect.catch(() => Effect.succeed(undefined)));

const packageName = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

/**
 * Reads every TypeScript and JavaScript file under the workspace and reports the imports between them. A file is
 * listed with `git ls-files` (so ignored files are left out) or, outside a repository, by walking the tree.
 * Aliases from the nearest tsconfig `baseUrl` and `paths`, and workspace packages named in a package.json, are
 * followed; `extends` chains, `exports` patterns and bundler plugins are not, and what that leaves behind is listed
 * as unresolved rather than guessed.
 */
export const scanWorkspace = Effect.fn("Scan.workspace")(function* (workspace: string) {
  const root = yield* io("Scan.workspace", () => realpath(workspace));
  const { listing, paths } = yield* listFiles(root);
  const files = new Set(paths);

  const aliases = new Map<string, Alias>();
  const packages: WorkspacePackage[] = [];
  yield* Effect.forEach(paths.filter(path => /(^|\/)(tsconfig|jsconfig)\.json$/.test(path) || (/(^|\/)package\.json$/.test(path) && !path.includes("node_modules/"))), path =>
    Effect.gen(function* () {
      const text = yield* readText(root, path);
      const parsed = text === undefined ? undefined : yield* json(relaxedJson(text)).pipe(Effect.option);
      const value = parsed?._tag === "Some" && parsed.value && typeof parsed.value === "object" ? parsed.value as Record<string, unknown> : undefined;
      if (!value) return;
      const directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
      if (basename(path) === "package.json") {
        if (typeof value.name === "string") packages.push({ name: value.name, directory, entries: packageEntries(value), subpaths: packageSubpaths(value) });
        return;
      }
      const options = value.compilerOptions && typeof value.compilerOptions === "object" ? value.compilerOptions as Record<string, unknown> : {};
      const paths = options.paths && typeof options.paths === "object" ? options.paths as Record<string, readonly string[]> : {};
      const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : undefined;
      if (baseUrl !== undefined || Object.keys(paths).length) aliases.set(directory, { directory, baseUrl, paths });
    }), { concurrency: 8, discard: true });
  packages.sort((a, b) => b.name.length - a.name.length);

  const join_ = (directory: string, rest: string) => posix.normalize(directory ? posix.join(directory, rest) : rest);
  const fromAlias = (from: string, specifier: string) => {
    for (let directory = posix.dirname(from) === "." ? "" : posix.dirname(from); ; directory = posix.dirname(directory) === "." ? "" : posix.dirname(directory)) {
      const alias = aliases.get(directory);
      if (alias) {
        for (const [pattern, targets] of Object.entries(alias.paths)) {
          const star = pattern.indexOf("*");
          const matched = star < 0 ? specifier === pattern ? "" : undefined
            : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1)) && specifier.length >= pattern.length - 1
              ? specifier.slice(star, specifier.length - (pattern.length - star - 1)) : undefined;
          if (matched === undefined) continue;
          for (const target of targets) {
            const found = resolveFile(files, join_(join_(directory, alias.baseUrl ?? "."), target.replace("*", matched)));
            if (found) return found;
          }
        }
        if (alias.baseUrl !== undefined) {
          const found = resolveFile(files, join_(join_(directory, alias.baseUrl), specifier));
          if (found) return found;
        }
      }
      if (!directory) return undefined;
    }
  };
  const fromPackage = (specifier: string) => {
    const owner = packages.find(item => specifier === item.name || specifier.startsWith(`${item.name}/`));
    if (!owner) return undefined;
    const rest = specifier.slice(owner.name.length + 1);
    // An export usually names built output (`dist/index.mjs`); the same path under `src` is its source.
    const sourcesOf = (entry: string) => {
      const target = join_(owner.directory, entry), source = target.replace(/(^|\/)(dist|build|lib|out)\//, "$1src/");
      return [target, source, source.slice(0, source.length - extension(source).length)];
    };
    const candidates = rest ? [...(owner.subpaths.get(rest) ?? []).flatMap(sourcesOf), join_(owner.directory, rest), join_(owner.directory, `src/${rest}`)]
      : [...owner.entries.flatMap(sourcesOf), join_(owner.directory, "src/index"), join_(owner.directory, "index")];
    for (const candidate of candidates) { const found = resolveFile(files, candidate); if (found) return { file: found }; }
    return { missing: true as const };
  };

  const imports: Scan["imports"][number][] = [];
  const unresolved: Scan["unresolved"][number][] = [];
  const external = new Map<string, Scan["external"][number]>();
  const scanned: Scan["files"][number][] = [];
  let skipped = 0;
  const sourcePaths = paths.filter(path => extension(path) in languages);
  yield* Effect.forEach(sourcePaths, path => Effect.gen(function* () {
    const text = yield* readText(root, path);
    if (text === undefined) { skipped++; return; }
    scanned.push({ path, language: languages[extension(path)]!, lines: text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0 });
    for (const { specifier: raw, line, kind } of importsOf(text)) {
      const specifier = raw.replace(/(?!^)[?#].*$/, "");
      if (!specifier) continue;
      const note = (reason: Scan["unresolved"][number]["reason"]) => unresolved.push({ from: path, specifier: raw, line, kind, reason });
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
        const found = resolveFile(files, join_(posix.dirname(path) === "." ? "" : posix.dirname(path), specifier));
        if (found) imports.push({ from: path, to: found, line, kind, specifier: raw }); else note("not-found");
        continue;
      }
      if (specifier.startsWith("/")) { note("not-found"); continue; }
      const aliased = fromAlias(path, specifier);
      if (aliased) { imports.push({ from: path, to: aliased, line, kind, specifier: raw }); continue; }
      const workspacePackage = fromPackage(specifier);
      if (workspacePackage?.file) { imports.push({ from: path, to: workspacePackage.file, line, kind, specifier: raw }); continue; }
      if (workspacePackage) { note("package-entry-not-found"); continue; }
      if (/^(@\/|~\/|#)/.test(specifier)) { note("alias-not-configured"); continue; }
      const name = specifier.includes(":") ? specifier : packageName(specifier);
      const key = `${path}\0${name}`;
      if (!external.has(key)) external.set(key, { from: path, package: name, line, kind });
    }
  }), { concurrency: 16, discard: true });

  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const unscannedCounts = new Map<string, number>();
  for (const path of paths) if (unscannedExtensions.has(extension(path))) unscannedCounts.set(extension(path), (unscannedCounts.get(extension(path)) ?? 0) + 1);
  const unique = <T extends { from: string; line: number }>(items: T[], key: (item: T) => string) =>
    [...new Map(items.map(item => [key(item), item])).values()].sort((a, b) => order(a.from, b.from) || a.line - b.line || order(key(a), key(b)));
  const resolvedImports = unique(imports, item => `${item.from}\0${item.line}\0${item.to}\0${item.kind}\0${item.specifier}`);
  const unresolvedImports = unique(unresolved, item => `${item.from}\0${item.line}\0${item.specifier}\0${item.kind}`);
  const externalImports = [...external.values()].sort((a, b) => order(a.from, b.from) || order(a.package, b.package));
  return Scan.make({
    version: 1, basis: "static", root: basename(root),
    files: scanned.sort((a, b) => order(a.path, b.path)),
    imports: resolvedImports, external: externalImports, unresolved: unresolvedImports,
    coverage: { listing, files: scanned.length, imports: resolvedImports.length, external: externalImports.length, unresolved: unresolvedImports.length, skipped,
      unscanned: [...unscannedCounts].sort(([a], [b]) => order(a, b)).map(([ext, count]) => ({ extension: ext, files: count })) },
  });
});

export type { ImportKind };
