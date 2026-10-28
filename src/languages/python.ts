import { posix } from "node:path";
import { Effect } from "effect";
import type { ExportRef, ImportRef } from "../scan-imports";
import type { FrontEnd, Resolution, Workspace } from "./index";
import file from "./grammars/tree-sitter-python.wasm" with { type: "file" };
import { descendants, grammar, type Node } from "./tree-sitter";

/**
 * Python. Statements are found anywhere in a file (a function body, a `try:`, an `if`); an import under `if TYPE_CHECKING:` is a type import, and
 * `importlib.import_module("a.b")` or `__import__("a.b")` with a literal is a dynamic one. Modules resolve against the project's roots the way the
 * interpreter would with those roots on `sys.path`; `sys.path` edits, `PYTHONPATH` and `.pth` files are not followed.
 */
const parser = grammar(file);

const isTypeChecking = (condition: Node | null) => condition !== null && /^(\w+\.)?TYPE_CHECKING$/.test(condition.text);
const named = (node: Node) => node.type === "aliased_import"
  ? { imported: node.childForFieldName("name")!.text, exported: node.childForFieldName("alias")!.text }
  : { imported: node.text, exported: node.text };

function imports(source: string, path: string): ImportRef[] {
  const found: ImportRef[] = [];
  // A package's `__init__.py` offers what it imports from its own modules (`from .mod import name`) to whoever imports the package, so those lines are
  // followed like `export … from`. Its other imports are its own, followed like any file's.
  const barrel = posix.basename(path) === "__init__.py";
  const typeOnly: [number, number][] = [];
  for (const node of descendants(parser.parse(source))) {
    const line = node.startPosition.row + 1;
    const kind = typeOnly.some(([start, end]) => node.startIndex >= start && node.startIndex < end) ? "type" as const : "import" as const;
    if (node.type === "if_statement" && isTypeChecking(node.childForFieldName("condition"))) {
      const block = node.childForFieldName("consequence");
      if (block) typeOnly.push([block.startIndex, block.endIndex]);
    } else if (node.type === "import_statement") {
      for (const name of node.childrenForFieldName("name")) if (name) found.push({ specifier: named(name).imported, line, kind });
    } else if (node.type === "import_from_statement" || node.type === "future_import_statement") {
      const module = node.type === "future_import_statement" ? "__future__" : node.childForFieldName("module_name")!.text;
      const names = node.children.some(child => child?.type === "wildcard_import") ? "*" as const
        : node.childrenForFieldName("name").flatMap(name => name ? [named(name)] : []);
      found.push({ specifier: module, line, kind, names, ...barrel && module.startsWith(".") ? { reexport: true as const } : {} });
    } else if (node.type === "call" && /^(importlib\.import_module|import_module|__import__)$/.test(node.childForFieldName("function")?.text ?? "")) {
      const first = node.childForFieldName("arguments")?.namedChildren[0];
      // Only a plain literal names a module; an f-string or a relative name (which needs its `package` argument) does not.
      const parts = first?.type === "string" ? first.namedChildren : [];
      const content = parts.length === 3 && parts[1]?.type === "string_content" ? parts[1].text : undefined;
      if (content && /^[A-Za-z_][\w.]*$/.test(content)) found.push({ specifier: content, line, kind: "dynamic" });
    }
  }
  return found;
}

/** The top-level statements of a module, a decorated definition unwrapped. */
const topLevel = (source: string) => parser.parse(source).namedChildren.flatMap(node => !node ? [] : node.type === "decorated_definition" ? [node.childForFieldName("definition") ?? node] : [node]);
/** `a = 1`, `a: int = 1`, `a = b = 1`, `a, b = …`: each assignment of a statement. */
const assignments = (node: Node) => {
  const found: Node[] = [];
  for (let at = node.type === "expression_statement" ? node.namedChildren[0] : null; at?.type === "assignment"; at = at.childForFieldName("right")) found.push(at);
  return found;
};
const targets = (node: Node | null): string[] => !node ? [] : node.type === "identifier" ? [node.text]
  : ["pattern_list", "tuple_pattern", "list_pattern"].includes(node.type) ? node.namedChildren.flatMap(child => targets(child)) : [];

/**
 * What a module defines at its top level: functions, classes, assignments and type aliases, names starting with `_` left out, then the names `__all__`
 * lists that it does not define itself, which it offers from elsewhere (`reexport`).
 */
function exports(source: string, limit = 80): ExportRef[] {
  const found: ExportRef[] = [], seen = new Set<string>(), listed: string[] = [];
  const add = (name: string, kind: ExportRef["kind"]) => { if (!seen.has(name) && found.length < limit) { seen.add(name); found.push({ name, kind }); } };
  for (const node of topLevel(source)) {
    if (node.type === "function_definition" || node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name && !name.startsWith("_")) add(name, node.type === "class_definition" ? "class" : "function");
    } else if (node.type === "type_alias_statement") {
      const name = node.childForFieldName("left")?.text;
      if (name && !name.startsWith("_")) add(name, "type");
    } else for (const assignment of assignments(node)) {
      const names = targets(assignment.childForFieldName("left"));
      const value = assignment.childForFieldName("right");
      if (names.includes("__all__") && value && ["list", "tuple"].includes(value.type)) for (const item of value.namedChildren) {
        const content = item?.type === "string" ? item.namedChildren.find(child => child?.type === "string_content")?.text : undefined;
        if (content) listed.push(content);
      }
      for (const name of names) if (!name.startsWith("_")) add(name, "const");
    }
  }
  for (const name of listed) add(name, seen.has(name) ? "named" : "reexport");
  return found;
}

/** A function or class as it is declared, decorators left out and the body cut off: `def name(args) -> T`. */
function declaration(source: string, name: string): string | undefined {
  const node = topLevel(source).find(item => (item.type === "function_definition" || item.type === "class_definition") && item.childForFieldName("name")?.text === name);
  const body = node?.childForFieldName("body");
  if (!node || !body) return undefined;
  const text = source.slice(node.startIndex, body.startIndex).replace(/\s+/g, " ").trim().replace(/\s*:$/, "");
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/**
 * Roots, where an absolute module name starts: the directory of each `pyproject.toml`, `setup.py` or `setup.cfg`, its `src/` when there is one, a
 * directory the project's `package-dir` (`package_dir`, Poetry's `from`) names, and the workspace root. The nearest root at or above a file governs it;
 * the others are tried after.
 */
const resolver = Effect.fn("Scan.python")(function* (workspace: Workspace) {
  const { files, paths } = workspace;
  const directories = new Set<string>();
  for (const path of paths) if (path.endsWith(".py")) for (let at = posix.dirname(path); at !== "."; at = posix.dirname(at)) directories.add(at);
  const join_ = (...parts: string[]) => parts.filter(Boolean).join("/");
  const roots = new Set<string>([""]);
  for (const path of paths.filter(item => /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/.test(item))) {
    const directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
    roots.add(directory);
    if (directories.has(join_(directory, "src"))) roots.add(join_(directory, "src"));
    const text = (yield* workspace.read(path)) ?? "";
    // `package-dir = { "" = "lib" }`, `package_dir = {"": "lib"}`, `package_dir = =lib`, Poetry's `{ include = "x", from = "lib" }`; a named package's
    // directory (`"pkg" = "lib/pkg"`) makes its parent a root.
    const given = [
      ...[...text.matchAll(/package[-_]dir\s*=\s*\{([^}]*)\}/g)].flatMap(match => [...match[1]!.matchAll(/["']([\w.]*)["']\s*[:=]\s*["']([^"']+)["']/g)]
        .map(([, name, dir]) => !name ? dir : dir!.endsWith(`/${name.replace(/\./g, "/")}`) ? dir!.slice(0, dir!.length - name.length - 1) : undefined)),
      ...[...text.matchAll(/package_dir\s*=\s*\n?\s*=\s*([\w./-]+)/g)].map(match => match[1]),
      ...[...text.matchAll(/\binclude\s*=\s*"[^"]+"\s*,\s*from\s*=\s*"([^"]+)"/g)].map(match => match[1]),
    ];
    for (const dir of given) if (dir) roots.add(posix.normalize(join_(directory, dir)).replace(/\/$/, "").replace(/^\.$/, ""));
  }
  const ordered = [...roots].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const rootsFor = (from: string) => {
    const inside = (root: string) => !root || from.startsWith(`${root}/`);
    return [...ordered.filter(inside), ...ordered.filter(root => !inside(root))];
  };
  // A module is a file (`a/b.py`), a package (`a/b/__init__.py`), or a namespace package: a folder of Python files with no `__init__.py`, which
  // resolves but has no file of its own to record.
  const moduleAt = (stem: string): { file?: string } | undefined => {
    for (const candidate of [`${stem}.py`, join_(stem, "__init__.py")]) if (files.has(candidate)) return { file: candidate };
    return stem && directories.has(stem) ? {} : undefined;
  };

  return (from: string, { specifier, names }: ImportRef): Resolution => {
    const level = /^\.*/.exec(specifier)![0].length;
    const segments = specifier.slice(level).split(".").filter(Boolean);
    let bases: string[];
    if (level) {
      let base = posix.dirname(from) === "." ? "" : posix.dirname(from);
      for (let up = 1; up < level; up++) {
        if (!base) return { unresolved: "not-found" };
        base = posix.dirname(base) === "." ? "" : posix.dirname(base);
      }
      bases = [base];
    } else bases = rootsFor(from);
    for (const base of bases) {
      const stem = join_(base, ...segments);
      const module = moduleAt(stem);
      if (!module) continue;
      // `import a.b` and `from a.b import *` reach the module; `from a.b import c` reaches `a/b/c.py` when `c` is a module, else `c` in `a/b`.
      if (names === undefined || names === "*") return module.file ? { files: [{ to: module.file, names }] } : undefined;
      const reached: { to: string; names?: { imported: string; exported: string }[] }[] = [];
      const symbols: { imported: string; exported: string }[] = [];
      for (const name of names) {
        const submodule = moduleAt(join_(stem, name.imported));
        if (submodule?.file) reached.push({ to: submodule.file });
        else if (!submodule) symbols.push(name);
      }
      if (symbols.length && module.file) reached.push({ to: module.file, names: symbols });
      else if (symbols.length && !reached.length) return { unresolved: "not-found" };
      return reached.length ? { files: reached } : undefined;
    }
    // A name under no root is a package from outside, unless the workspace has a top-level package of that name: then the module is missing from it.
    if (level || (segments[0] && ordered.some(root => moduleAt(join_(root, segments[0]!)) !== undefined))) return { unresolved: "not-found" };
    return segments[0] ? { external: segments[0] } : undefined;
  };
});

export const python: FrontEnd = { languages: { ".py": "python" }, load: parser.load, imports, exports, declaration, resolver };
