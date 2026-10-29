import { basename, posix } from "node:path";
import { Effect } from "effect";
import { exports as packageExports, imports as packageImports } from "resolve.exports";
import { json } from "../effects";
import { declarationOf, exportsOf, importsOf, type ImportRef } from "../scan-imports";
import type { FrontEnd, Resolution, Workspace } from "./index";

/**
 * TypeScript and JavaScript: the hand-written tokenizer in `scan-imports.ts` reads the imports (it is measured against an independent resolver, so it
 * stays), and resolution follows what TypeScript and Node do. This front end is the scan as it was before there were others, moved here unchanged.
 */
const languages = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
} as const;
const sourceExtensions = Object.keys(languages);
const jsToTs: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

const extension = (path: string) => posix.extname(path);

/** The file a path names, trying what TypeScript and Node do: the exact file, `.js` for `.ts`, an added extension, then a directory index. */
function resolveFile(files: ReadonlySet<string>, requested: string): string | undefined {
  if (requested.startsWith("../") || requested === "..") return undefined;
  // `./` and `../` name the folder itself, like `.` and `..` do: its index file.
  const base = requested.replace(/\/+$/, "");
  if (requested.endsWith("/")) {
    const prefix = base ? `${base}/` : "";
    for (const added of sourceExtensions) if (files.has(`${prefix}index${added}`)) return `${prefix}index${added}`;
    return undefined;
  }
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
interface WorkspacePackage { readonly name: string; readonly directory: string; readonly manifest: Record<string, unknown>; readonly entries: readonly string[] }

// The files a package.json `exports` value (or `main`, `module`, `types`) points at, whatever condition names it nests them under.
const targetsOf = (value: unknown): string[] => typeof value === "string" ? [value]
  : value && typeof value === "object" ? ["import", "module", "default", "types", "require"].flatMap(key => targetsOf((value as Record<string, unknown>)[key])) : [];

const packageEntries = (manifest: Record<string, unknown>) => {
  const exported = manifest.exports;
  const root = exported && typeof exported === "object" && "." in exported ? (exported as Record<string, unknown>)["."] : exported;
  return [...targetsOf(root), ...["module", "main", "types"].flatMap(key => targetsOf(manifest[key]))];
};

/**
 * `exports` and `imports` (`#name`) in a package.json map a specifier, per runtime condition, to files in that package, including
 * `*` patterns. A static scan cannot know the runtime, so every condition the manifest names is followed and each variant is
 * reported (a platform file next to its siblings is one module in several forms). Resolution itself is `resolve.exports`.
 */
const conditionsOf = (value: unknown): string[] => value && typeof value === "object"
  ? Object.entries(value).flatMap(([key, nested]) => [key, ...conditionsOf(nested)]) : [];
const mapped = (manifest: Record<string, unknown>, field: "exports" | "imports", specifier: string) => {
  const named = [...new Set(conditionsOf(manifest[field]))].filter(key => !/^(#|\.\/|types|require|default|import)/.test(key));
  const targets = new Set<string>();
  for (const condition of ["import", ...named]) {
    try {
      const found = field === "exports" ? packageExports(manifest, specifier, { unsafe: true, conditions: [condition, "import", "default"] })
        : packageImports(manifest, specifier, { unsafe: true, conditions: [condition, "import", "default"] });
      for (const target of found ?? []) if (target.startsWith("./")) targets.add(target.slice(2));
    } catch { /* the manifest does not map this specifier */ }
  }
  return [...targets];
};

const packageName = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

/**
 * Aliases from the nearest tsconfig `baseUrl` and `paths`, and workspace packages named in a package.json, are followed, as are `exports` and `imports`
 * maps (patterns and runtime conditions included); `extends` chains and bundler aliases are not, and what that leaves behind is listed as unresolved
 * rather than guessed.
 */
const resolver = Effect.fn("Scan.typescript")(function* (workspace: Workspace) {
  const { paths, files } = workspace;
  const aliases = new Map<string, Alias>();
  const packages: WorkspacePackage[] = [];
  // Every package.json by directory, for `#` specifiers (the nearest one governs a file).
  const manifests = new Map<string, Record<string, unknown>>();
  yield* Effect.forEach(paths.filter(path => /(^|\/)(tsconfig|jsconfig)\.json$/.test(path) || (/(^|\/)package\.json$/.test(path) && !path.includes("node_modules/"))), path =>
    Effect.gen(function* () {
      const text = yield* workspace.read(path);
      const parsed = text === undefined ? undefined : yield* json(relaxedJson(text)).pipe(Effect.option);
      const value = parsed?._tag === "Some" && parsed.value && typeof parsed.value === "object" ? parsed.value as Record<string, unknown> : undefined;
      if (!value) return;
      const directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
      if (basename(path) === "package.json") {
        manifests.set(directory, value);
        if (typeof value.name === "string") packages.push({ name: value.name, directory, manifest: value, entries: packageEntries(value) });
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
  const fromSubpathImport = (from: string, specifier: string) => {
    let directory = posix.dirname(from) === "." ? "" : posix.dirname(from);
    while (!manifests.has(directory) && directory) directory = posix.dirname(directory) === "." ? "" : posix.dirname(directory);
    const manifest = manifests.get(directory);
    if (!manifest) return [];
    return [...new Set(mapped(manifest, "imports", specifier).flatMap(target => resolveFile(files, join_(directory, target)) ?? []))].filter(target => target !== from).sort();
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
    // The manifest's `exports` map first (every runtime variant it names); a package without a usable one falls back to the conventional layout.
    const declared = owner.manifest.exports === undefined ? [] : [...new Set(mapped(owner.manifest, "exports", specifier).flatMap(entry =>
      sourcesOf(entry).flatMap(candidate => resolveFile(files, candidate) ?? []).slice(0, 1)))].sort();
    if (declared.length) return { files: declared };
    const candidates = rest ? [join_(owner.directory, rest), join_(owner.directory, `src/${rest}`)]
      : [...owner.entries.flatMap(sourcesOf), join_(owner.directory, "src/index"), join_(owner.directory, "index")];
    for (const candidate of candidates) { const found = resolveFile(files, candidate); if (found) return { files: [found] }; }
    return { missing: true as const };
  };

  return (path: string, { specifier: raw, names }: ImportRef): Resolution => {
    const reached = (to: readonly string[]) => ({ files: to.map(file => ({ to: file, names })) });
    const specifier = raw.replace(/(?!^)[?#].*$/, "");
    if (!specifier) return undefined;
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
      const found = resolveFile(files, join_(posix.dirname(path) === "." ? "" : posix.dirname(path), specifier));
      return found ? reached([found]) : { unresolved: "not-found" };
    }
    if (specifier.startsWith("/")) return { unresolved: "not-found" };
    const aliased = fromAlias(path, specifier);
    if (aliased) return reached([aliased]);
    const workspacePackage = fromPackage(specifier);
    if (workspacePackage?.files) return reached(workspacePackage.files);
    if (workspacePackage) return { unresolved: "package-entry-not-found" };
    if (specifier.startsWith("#")) {
      const targets = fromSubpathImport(path, specifier);
      return targets.length ? reached(targets) : { unresolved: "alias-not-configured" };
    }
    if (/^(@\/|~\/)/.test(specifier)) return { unresolved: "alias-not-configured" };
    return { external: specifier.includes(":") ? specifier : packageName(specifier) };
  };
});

export const typescript: FrontEnd = {
  languages,
  load: () => Promise.resolve(),
  imports: source => importsOf(source),
  exports: (source, limit) => exportsOf(source, limit),
  declaration: declarationOf,
  resolver,
};
