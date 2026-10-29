import { posix } from "node:path";
import { Effect } from "effect";
import type { ExportRef, ImportRef } from "../scan-imports";
import type { FrontEnd, Resolution, Workspace } from "./index";
import file from "./grammars/tree-sitter-go.wasm" with { type: "file" };
import { descendants, grammar, type Node } from "./tree-sitter";

/**
 * Go. An import names a package, a folder of files, so it is recorded against the files of that package that declare the names the importing file
 * uses (`storage.New`, `storage.Entry`), one record per file reached, the way a TypeScript import is followed through a barrel. A dot or blank import,
 * or a used name no file declares, reaches every file of the package. Test files are read as sources and are never targets. Build constraints are not
 * evaluated: every file is read, whatever its tags.
 */
const parser = grammar(file);

/** A Go import carries what the file uses through each package name, so resolution can pick the files that declare those names. */
interface GoImport extends ImportRef { readonly alias?: string; readonly uses: ReadonlyMap<string, ReadonlySet<string>> }

const isTest = (path: string) => path.endsWith("_test.go");
const vendored = (path: string) => /(^|\/)vendor\//.test(path);
const exported = (name: string) => /^\p{Lu}/u.test(name);

function imports(source: string): ImportRef[] {
  const root = parser.parse(source);
  // `pkg.Name` in an expression and `pkg.Type` in a type, by the name before the dot. Only exported names can come from another package.
  const uses = new Map<string, Set<string>>();
  const use = (qualifier: Node | null, name: Node | null) => {
    if (!qualifier || !name || !exported(name.text)) return;
    const set = uses.get(qualifier.text) ?? new Set<string>();
    set.add(name.text);
    uses.set(qualifier.text, set);
  };
  const found: GoImport[] = [];
  for (const node of descendants(root)) {
    if (node.type === "selector_expression") {
      const operand = node.childForFieldName("operand");
      if (operand?.type === "identifier") use(operand, node.childForFieldName("field"));
    } else if (node.type === "qualified_type") use(node.childForFieldName("package"), node.childForFieldName("name"));
    else if (node.type === "import_spec") {
      const path = node.childForFieldName("path");
      const specifier = path?.namedChildren.find(child => child?.type === "interpreted_string_literal_content" || child?.type === "raw_string_literal_content")?.text;
      if (specifier) found.push({ specifier, line: node.startPosition.row + 1, kind: "import", alias: node.childForFieldName("name")?.text, uses });
    }
  }
  return found;
}

/** Exported top-level declarations: functions, types, variables and constants. Methods are not listed, since no other package names them through the package. */
function exports(source: string, limit = 80): ExportRef[] {
  const found: ExportRef[] = [];
  const add = (name: string | undefined, kind: ExportRef["kind"]) => { if (name && exported(name) && found.length < limit) found.push({ name, kind }); };
  for (const node of parser.parse(source).namedChildren) {
    if (!node) continue;
    if (node.type === "function_declaration") add(node.childForFieldName("name")?.text, "function");
    else if (node.type === "type_declaration") for (const spec of node.namedChildren) {
      if (spec?.type !== "type_spec" && spec?.type !== "type_alias") continue;
      const type = spec.childForFieldName("type")?.type;
      add(spec.childForFieldName("name")?.text, type === "interface_type" ? "interface" : type === "struct_type" ? "class" : "type");
    } else if (node.type === "var_declaration" || node.type === "const_declaration") {
      for (const spec of descendants(node)) if (spec.type === "var_spec" || spec.type === "const_spec") for (const name of spec.childrenForFieldName("name")) add(name?.text, "const");
    }
  }
  return found;
}

/** The top-level function, method or type spec that declares a name. */
const declared = (source: string, name: string) => {
  for (const node of parser.parse(source).namedChildren) {
    if (!node) continue;
    if ((node.type === "function_declaration" || node.type === "method_declaration") && node.childForFieldName("name")?.text === name) return node;
    if (node.type === "type_declaration") for (const spec of node.namedChildren) {
      if ((spec?.type === "type_spec" || spec?.type === "type_alias") && spec.childForFieldName("name")?.text === name) return spec;
    }
  }
  return undefined;
};

/** A function, method or type as it is declared, its body cut off: `func (r *T) Name(a int) error`, `type Entry struct`. */
function declaration(source: string, name: string): string | undefined {
  const clip = (text: string) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat; };
  const node = declared(source, name);
  if (!node) return undefined;
  if (node.type === "function_declaration" || node.type === "method_declaration") {
    const body = node.childForFieldName("body");
    return clip(source.slice(node.startIndex, body ? body.startIndex : node.endIndex));
  }
  // A struct or interface stops at its keyword; anything else is short enough to keep whole.
  const type = node.childForFieldName("type");
  const keyword = type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : undefined;
  return clip(`type ${keyword ? `${source.slice(node.startIndex, type!.startIndex)}${keyword}` : node.text}`);
}
const declarationLine = (source: string, name: string) => { const node = declared(source, name); return node ? node.startPosition.row + 1 : undefined; };

/**
 * Modules: the nearest `go.mod` above a file names its module, a nested `go.mod` is its own module, `go.work` lists modules that are each a root, and a
 * `replace` to a local path is followed. An import path inside a module resolves to that folder of the module. Anything else (the standard library,
 * another module) is from outside.
 */
const resolver = Effect.fn("Scan.go")(function* (workspace: Workspace) {
  const { paths, declared } = workspace;
  const directory = (path: string) => posix.dirname(path) === "." ? "" : posix.dirname(path);
  const join_ = (...parts: string[]) => posix.normalize(parts.filter(Boolean).join("/") || ".").replace(/^\.$/, "");
  const inWorkspace = (path: string) => path !== ".." && !path.startsWith("../");
  // Each package's files (tests and vendored code left out) and the name its files declare in their `package` clause.
  const packages = new Map<string, string[]>();
  for (const path of paths) if (path.endsWith(".go") && !isTest(path) && !vendored(path)) packages.set(directory(path), [...packages.get(directory(path)) ?? [], path]);
  const names = new Map<string, string>();
  for (const [folder, files] of packages) {
    const text = (yield* workspace.read(files[0]!)) ?? "";
    const name = /^\s*package\s+(\w+)/m.exec(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))?.[1];
    if (name) names.set(folder, name);
  }
  // Every module by folder, with the modules each one can reach by path: itself, its local replacements, and what go.work lists.
  const modules = new Map<string, { path: string; replaces: Map<string, string> }>();
  for (const path of paths.filter(item => /(^|\/)go\.mod$/.test(item) && !vendored(item))) {
    const text = (yield* workspace.read(path)) ?? "";
    const module = /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1];
    if (!module) continue;
    const replaces = new Map<string, string>();
    for (const [, from, to] of text.matchAll(/^\s*(?:replace\s+)?([^\s(=]+)(?:\s+v[^\s=]+)?\s+=>\s+(\.{1,2}\/[^\s]*|\.{1,2})\s*$/gm)) {
      const target = join_(directory(path), to!);
      if (inWorkspace(target)) replaces.set(from!, target);
    }
    modules.set(directory(path), { path: module, replaces });
  }
  const used = [] as string[];
  for (const path of paths.filter(item => /(^|\/)go\.work$/.test(item))) {
    const text = (yield* workspace.read(path)) ?? "";
    for (const block of text.matchAll(/^\s*use\s+(?:\(([^)]*)\)|(\S+))/gm)) for (const entry of (block[1] ?? block[2] ?? "").split(/\s+/).filter(item => item && !item.startsWith("//")))
      used.push(join_(directory(path), entry.replace(/^"|"$/g, "")));
  }
  const moduleOf = (path: string) => {
    for (let at = directory(path); ; at = directory(at)) { if (modules.has(at)) return at; if (!at) return undefined; }
  };
  // The folder an import path names, through the longest module path that prefixes it.
  const folderFor = (from: string, specifier: string) => {
    const home = moduleOf(from);
    const reachable: [string, string][] = [];
    if (home !== undefined) {
      reachable.push([modules.get(home)!.path, home]);
      for (const [path, target] of modules.get(home)!.replaces) reachable.push([path, target]);
    }
    for (const folder of used) if (modules.has(folder)) reachable.push([modules.get(folder)!.path, folder]);
    const match = reachable.filter(([path]) => specifier === path || specifier.startsWith(`${path}/`)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!match) return undefined;
    const folder = join_(match[1], specifier.slice(match[0].length + 1));
    // A folder inside a nested module belongs to that module, not to the one whose path prefixes the import.
    return { folder, owned: moduleOf(`${folder}/x.go`) === match[1] };
  };

  return (from: string, ref: ImportRef): Resolution => {
    const { specifier, alias, uses } = ref as GoImport;
    const target = folderFor(from, specifier);
    if (!target) return { external: specifier };
    const files = target.owned ? packages.get(target.folder) ?? [] : [];
    if (!files.length) return { unresolved: "not-found" };
    if (alias === "." || alias === "_") return { files: files.map(to => ({ to })) };
    const wanted = [...uses.get(alias ?? names.get(target.folder) ?? posix.basename(target.folder)) ?? []].sort();
    const reached = new Map<string, string[]>();
    for (const name of wanted) {
      const declaring = files.filter(path => declared.get(path)?.has(name));
      // A name no file declares (a method value, a name the reading missed) keeps the whole package.
      if (!declaring.length) return { files: files.map(to => ({ to, names: wanted.map(item => ({ imported: item, exported: item })) })) };
      for (const path of declaring) reached.set(path, [...reached.get(path) ?? [], name]);
    }
    if (!reached.size) return { files: files.map(to => ({ to })) };
    return { files: [...reached].map(([to, taken]) => ({ to, names: taken.map(name => ({ imported: name, exported: name })) })) };
  };
});

export const go: FrontEnd = { languages: { ".go": "go" }, load: parser.load, imports, exports, declaration, declarationLine, resolver, skips: vendored };
