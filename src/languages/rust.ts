import { posix } from "node:path";
import { Effect } from "effect";
import type { ExportRef, ImportNames, ImportRef } from "../scan-imports";
import { strongest, type How, type Use } from "../uses";
import type { FrontEnd, Resolution, Workspace } from "./index";
import file from "./grammars/tree-sitter-rust.wasm" with { type: "file" };
import { descendants, grammar, type Node } from "./tree-sitter";

/**
 * Rust. A `use` (every form: groups, renames, globs, `pub use`), an `extern crate` and a path written in code whose first segment is `crate`, `self`,
 * `super`, `::` or a crate's name are imports; each is recorded against the file that declares the name, through the crate's module tree (`mod x;` to
 * `x.rs` or `x/mod.rs`, `#[path]`, inline modules), and a `pub use` is followed on like a TypeScript barrel. `mod x;` itself is structure, not an import.
 * Code under `#[cfg(test)]` is a test and is not read; any other `cfg` is not evaluated, so every file and module is read. Macros called by bare name,
 * method calls and `include!` are not followed. Crates and their targets come from each `Cargo.toml`; `vendor/` is someone else's code and is skipped.
 */
const parser = grammar(file);

/** One module scope of a file: the file itself (`[]`) or an inline `mod x { … }` inside it. */
interface Scope {
  readonly mods: { name: string; inline: boolean; path?: string; test: boolean }[];
  /** Items declared in the scope, which a path's first segment names before any crate. */
  readonly items: Set<string>;
  /** Names a `use` brings into the scope, with the paths each stands for: more than one under platform `cfg` (`use unix as platform`, `use windows as platform`). */
  readonly aliases: Map<string, string[][]>;
}
/**
 * What the resolver needs from a file besides its imports: its scopes, its `extern crate` names, the macros it exports (`#[macro_export]` puts them
 * at the crate's root, whatever module declares them), and whether the whole file is a test (`#![cfg(test)]`).
 */
interface Shape { readonly scopes: Map<string, Scope>; readonly externs: Map<string, string>; readonly macros: Set<string>; test: boolean }
interface RustImport extends ImportRef {
  readonly segments: readonly string[];
  /** The inline modules the import sits in, inside its file. */
  readonly scope: readonly string[];
  readonly use: boolean;
  readonly glob: boolean;
  readonly alias?: string;
  /** Carried by one record per file, which resolves to nothing: the file's shape, for the module tree. */
  readonly shape?: Shape;
}

const vendored = (path: string) => /(^|\/)vendor\//.test(path);
const std = new Set(["std", "core", "alloc", "proc_macro", "test"]);
const testAttribute = /^#\[\s*cfg\s*\(\s*test\s*\)\s*\]$/;
const itemTypes = new Set(["function_item", "struct_item", "enum_item", "union_item", "trait_item", "type_item", "const_item", "static_item", "macro_definition"]);
const segment = /^(r#)?[A-Za-z_]\w*$/;

/** `a::b::<T>::c` as its segments (`["a", "b", "c"]`), a leading `::` kept as a segment of its own; undefined for anything that is not a plain path. */
function segmentsOf(text: string): string[] | undefined {
  let flat = text.replace(/\s+/g, "");
  // Generic arguments, nested: `Vec::<Option<T>>::new`.
  for (let before = ""; before !== flat;) { before = flat; flat = flat.replace(/<[^<>]*>/g, ""); }
  const global = flat.startsWith("::");
  const parts = (global ? flat.slice(2) : flat).split("::");
  if (!parts.every(part => segment.test(part))) return undefined;
  return global ? ["::", ...parts] : parts;
}

const key = (segments: readonly string[]) => segments.join("::");

/** How a name or path is used, from where it sits: called (a function, `Type::method`, a macro), a struct literal, a trait implemented, a type, or a value. */
const howOf = (node: Node): How => {
  const parent = node.parent;
  const at = (holder: Node | null | undefined, field: string, child: Node) => holder?.childForFieldName(field)?.id === child.id;
  if (parent?.type === "call_expression" && at(parent, "function", node)) return "calls";
  if (parent?.type === "generic_function" && at(parent, "function", node) && parent.parent?.type === "call_expression") return "calls";
  if (parent?.type === "macro_invocation") return "calls";
  if (parent?.type === "struct_expression" && at(parent, "name", node)) return "constructs";
  if (parent?.type === "impl_item" && at(parent, "trait", node)) return "extends";
  if (parent?.type === "generic_type" && parent.parent?.type === "impl_item" && at(parent.parent, "trait", parent)) return "extends";
  if (node.type === "type_identifier" || node.type === "scoped_type_identifier") return "types";
  return "references";
};
/** The type an annotation is, through references and the smart pointers whose methods are the type's own (`&Client`, `Arc<Client>`), not a collection. */
const typeNames = (type: Node | null): string[] => {
  if (!type) return [];
  if (type.type === "type_identifier") return [type.text];
  if (type.type === "scoped_type_identifier") return [type.childForFieldName("name")?.text ?? ""].filter(Boolean);
  if (type.type === "reference_type") return typeNames(type.childForFieldName("type"));
  if (type.type === "generic_type" && /^(Arc|Rc|Box|Mutex|RwLock)$/.test(type.childForFieldName("type")?.text.split("::").at(-1) ?? "")) return typeNames(type.childForFieldName("type_arguments")?.namedChildren[0] ?? null);
  return [];
};
/** A path as the code writes it: `::regex::escape`, not `::::regex::escape`. */
const spell = (segments: readonly string[]) => segments[0] === "::" ? `::${key(segments.slice(1))}` : key(segments);

function read(source: string): RustImport[] {
  const shape: Shape = { scopes: new Map(), externs: new Map(), macros: new Set(), test: false };
  // Every name the file's code writes, for a glob: `use crate::assets::*` takes from the module only what the file goes on to name.
  const used = new Set<string>();
  const scopeOf = (scope: readonly string[]) => {
    let found = shape.scopes.get(key(scope));
    if (!found) shape.scopes.set(key(scope), found = { mods: [], items: new Set(), aliases: new Map() });
    return found;
  };
  scopeOf([]);
  const found: RustImport[] = [{ specifier: "", line: 1, kind: "import", segments: [], scope: [], use: false, glob: false, shape }];
  const seenPaths = new Set<string>();
  // How each name the file writes is used, by its first segment (`Client` in `Client::new()`, with the last segment as the member), and how each path in
  // code is used; a member called on a local annotated with an imported type is a call of that type.
  const occurrences = new Map<string, { member?: string; how: How }[]>();
  const pathHows = new Map<string, How[]>();
  const typed = new Map<string, Set<string>>(), called = new Map<string, Set<string>>();
  const occur = (name: string, member: string | undefined, how: How) => occurrences.set(name, [...occurrences.get(name) ?? [], { ...member ? { member } : {}, how }]);
  const codePath = (parts: string[], line: number, scope: string[], how: How = "references") => {
    // A path in code is an import only when it starts at a module or a crate: a type's `Self::`, `Vec::new` and a variant start with a capital.
    if (parts.length < 2 || !(parts[0] === "::" || /^[a-z_]/.test(parts[0]!))) return;
    pathHows.set(`${key(scope)}\0${key(parts)}`, [...pathHows.get(`${key(scope)}\0${key(parts)}`) ?? [], how]);
    if (seenPaths.has(`${key(scope)}\0${key(parts)}`)) return;
    seenPaths.add(`${key(scope)}\0${key(parts)}`);
    found.push({ specifier: spell(parts), line, kind: "import", names: [{ imported: parts.at(-1)!, exported: parts.at(-1)! }], segments: parts, scope, use: false, glob: false });
  };
  /** The paths written inside a macro's arguments (`writeln!(out, "{}", crate::assets::list())`), read from its tokens; strings are left alone. */
  const macroArguments = (tree: Node, scope: string[]) => {
    const tokens: { text: string; line: number }[] = [];
    const collect = (node: Node) => {
      if (/string_literal|char_literal|comment/.test(node.type)) { tokens.push({ text: "", line: 0 }); return; }
      if (node.childCount === 0) { tokens.push({ text: node.text, line: node.startPosition.row + 1 }); if (node.type === "identifier") { used.add(node.text); occur(node.text, undefined, "references"); } return; }
      for (const child of node.children) if (child) collect(child);
    };
    collect(tree);
    for (let index = 0; index < tokens.length; index++) {
      const start = tokens[index]!;
      if (!segment.test(start.text) || tokens[index - 1]?.text === "::" || tokens[index - 1]?.text === "." || tokens[index - 1]?.text === "$") continue;
      const parts = [start.text];
      let at = index + 1;
      while (tokens[at]?.text === "::" && segment.test(tokens[at + 1]?.text ?? "")) { parts.push(tokens[at + 1]!.text); at += 2; }
      if (parts.length > 1) codePath(parts, start.line, scope);
      index = at - 1;
    }
  };
  // The scopes open around the cursor: the depth of each scope's container (the file, or an inline module's body) and its path.
  const frames: { depth: number; scope: string[] }[] = [{ depth: 0, scope: [] }];
  // Attributes read so far before the next item, per depth: `#[cfg(test)]` and `#[path = "…"]` belong to the item that follows them.
  const pending: string[][] = [];

  const useTree = (node: Node, prefix: readonly string[], out: { segments: string[]; alias?: string; glob: boolean }[]) => {
    switch (node.type) {
      case "identifier": case "crate": case "super": case "metavariable":
        out.push({ segments: [...prefix, node.text], glob: false }); break;
      case "self":
        if (prefix.length) out.push({ segments: [...prefix], glob: false }); break;
      case "scoped_identifier": {
        const parts = segmentsOf(node.text);
        if (parts) out.push({ segments: [...prefix, ...parts], glob: false });
        break;
      }
      case "use_as_clause": {
        const path = node.childForFieldName("path"), alias = node.childForFieldName("alias")?.text;
        const parts = path?.type === "self" ? [] : path ? segmentsOf(path.text) : undefined;
        if (parts && (parts.length || prefix.length)) out.push({ segments: [...prefix, ...parts], alias, glob: false });
        break;
      }
      case "use_wildcard": {
        const path = node.namedChildren.find(child => child !== null);
        const parts = path ? segmentsOf(path.text) : [];
        if (parts) out.push({ segments: [...prefix, ...parts], glob: true });
        break;
      }
      case "scoped_use_list": {
        const path = node.childForFieldName("path"), list = node.childForFieldName("list");
        const parts = path ? segmentsOf(path.text) : node.text.trimStart().startsWith("::") ? ["::"] : [];
        if (parts && list) useTree(list, [...prefix, ...parts], out);
        break;
      }
      case "use_list":
        for (const child of node.namedChildren) if (child) useTree(child, prefix, out);
        break;
    }
  };

  /** Reads one node; true when its children are to be read too. */
  const visit = (node: Node, depth: number): boolean => {
    if (node.type === "line_comment" || node.type === "block_comment") return false;
    if (node.type === "identifier" || node.type === "type_identifier") { used.add(node.text); occur(node.text, undefined, howOf(node)); return false; }
    if (node.type === "parameter" || node.type === "let_declaration" || node.type === "field_declaration") {
      const name = node.childForFieldName(node.type === "field_declaration" ? "name" : "pattern");
      const local = name?.type === "identifier" || name?.type === "field_identifier" ? name.text : name?.type === "mut_pattern" ? name.namedChildren.find(child => child?.type === "identifier")?.text : undefined;
      if (local) for (const type of typeNames(node.childForFieldName("type"))) (typed.get(local) ?? typed.set(local, new Set()).get(local)!).add(type);
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const value = fn?.type === "field_expression" ? fn.childForFieldName("value") : null;
      const holder = value?.type === "identifier" ? value.text : value?.type === "field_expression" ? value.childForFieldName("field")?.text : value?.type === "self" ? undefined : undefined;
      const method = fn?.type === "field_expression" ? fn.childForFieldName("field")?.text : undefined;
      if (holder && method) (called.get(holder) ?? called.set(holder, new Set()).get(holder)!).add(method);
    }
    // `pub(in crate::service)` says who may see an item; it uses nothing.
    if (node.type === "visibility_modifier") return false;
    if (node.type === "attribute_item") { (pending[depth] ??= []).push(node.text); return false; }
    if (node.type === "inner_attribute_item") {
      if (depth === 1 && /^#!\[\s*cfg\s*\(\s*test\s*\)\s*\]$/.test(node.text)) shape.test = true;
      return false;
    }
    const attributes = pending[depth] ?? [];
    pending[depth] = [];
    const frame = frames.at(-1)!;
    const top = depth === frame.depth + 1;
    const scope = scopeOf(frame.scope);
    const line = node.startPosition.row + 1;
    const test = attributes.some(text => testAttribute.test(text.replace(/\s+/g, "")));
    if (node.type === "mod_item") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return false;
      const inline = node.childForFieldName("body") !== null;
      const path = attributes.map(text => /^#\[\s*path\s*=\s*"([^"]+)"\s*\]$/.exec(text)?.[1]).find(Boolean);
      scope.mods.push({ name, inline, ...path ? { path } : {}, test });
      scope.items.add(name);
      return inline && !test;
    }
    if (test) return false;
    if (node.type === "declaration_list" && node.parent?.type === "mod_item") {
      frames.push({ depth, scope: [...frame.scope, node.parent.childForFieldName("name")!.text] });
      return true;
    }
    if (top && itemTypes.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (name) scope.items.add(name);
    }
    if (node.type === "macro_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name && attributes.some(text => /^#\[\s*macro_export\b/.test(text))) shape.macros.add(name);
      // A macro's body is a pattern, not code of this module.
      return false;
    }
    if (node.type === "token_tree" && node.parent?.type === "macro_invocation") { macroArguments(node, frame.scope); return false; }
    if (node.type === "use_declaration") {
      const argument = node.childForFieldName("argument");
      const reexport = node.namedChildren.some(child => child?.type === "visibility_modifier");
      const leaves: { segments: string[]; alias?: string; glob: boolean }[] = [];
      if (argument) useTree(argument, [], leaves);
      for (const leaf of leaves) {
        if (!leaf.segments.length) continue;
        const last = leaf.segments.at(-1)!;
        const names = leaf.glob ? "*" as const : [{ imported: last, exported: leaf.alias ?? last }];
        found.push({ specifier: `${spell(leaf.segments)}${leaf.glob ? "::*" : ""}`, line, kind: "import", names, ...reexport ? { reexport: true as const } : {},
          segments: leaf.segments, scope: frame.scope, use: true, glob: leaf.glob, ...leaf.alias ? { alias: leaf.alias } : {} });
        if (!leaf.glob && (leaf.alias ?? last) !== "_" && !["crate", "self", "super"].includes(leaf.alias ?? last)) scope.aliases.set(leaf.alias ?? last, [...scope.aliases.get(leaf.alias ?? last) ?? [], leaf.segments]);
      }
      return false;
    }
    if (node.type === "extern_crate_declaration") {
      const name = node.childForFieldName("name")?.text, alias = node.childForFieldName("alias")?.text;
      if (name && name !== "self") {
        shape.externs.set(alias ?? name, name);
        found.push({ specifier: name, line, kind: "import", segments: [name], scope: frame.scope, use: true, glob: false });
      }
      return false;
    }
    if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
      const parts = segmentsOf(node.text);
      const how = howOf(node);
      if (parts) {
        codePath(parts, line, frame.scope, how);
        if (parts.length > 1) { occur(parts[0]!, parts.at(-1), how); used.add(parts[0]!); }
      }
      return false;
    }
    return true;
  };

  // A glob that is not offered on (`pub use …::*`) takes the names the file writes, so each can be followed to the file that declares it.
  const usesOf = (local: string, imported: string): Use[] => (occurrences.get(local) ?? []).map(item => ({ imported, name: item.member ? `${local}::${item.member}` : local, how: item.how }));
  const narrowed = () => {
    for (const [local, types] of typed) for (const method of called.get(local) ?? []) for (const type of types) occur(type, method, "calls");
    return found.map(ref => {
      if (ref.shape || !ref.segments.length) return ref;
      if (ref.glob && !ref.reexport) return { ...ref, names: [...used].sort().map(name => ({ imported: name, exported: name })), uses: strongest([...used].flatMap(name => usesOf(name, name))) };
      if (ref.glob) return ref;
      const last = ref.segments.at(-1)!;
      if (ref.use) return { ...ref, uses: strongest(usesOf(ref.alias ?? last, last)) };
      return { ...ref, uses: strongest((pathHows.get(`${key(ref.scope)}\0${key(ref.segments)}`) ?? []).map(how => ({ imported: last, name: last, how }))) };
    });
  };
  const cursor = parser.parse(source).walk();
  try {
    for (let depth = 0; ;) {
      if (visit(cursor.currentNode, depth) && cursor.gotoFirstChild()) { depth++; continue; }
      for (;;) {
        if (depth === 0) return narrowed();
        if (cursor.gotoNextSibling()) { while (frames.length > 1 && frames.at(-1)!.depth >= depth) frames.pop(); break; }
        cursor.gotoParent();
        pending[depth] = [];
        depth--;
        while (frames.length > 1 && frames.at(-1)!.depth > depth) frames.pop();
      }
    }
  } finally { cursor.delete(); }
}

const imports = (source: string): ImportRef[] => read(source);

const kinds: Record<string, ExportRef["kind"]> = {
  function_item: "function", struct_item: "class", union_item: "class", enum_item: "enum", trait_item: "interface", type_item: "type",
  const_item: "const", static_item: "const", mod_item: "namespace",
};

/** The attributes written before the item at `index`, doc comments between them skipped. */
const attributesBefore = (nodes: (Node | null)[], index: number) => {
  const found: string[] = [];
  for (let at = index - 1; at >= 0; at--) {
    const node = nodes[at];
    if (node?.type === "attribute_item") found.push(node.text);
    else if (node?.type !== "line_comment" && node?.type !== "block_comment") break;
  }
  return found;
};

/** Public top-level items (any `pub`), a `#[macro_export]` macro, then the names a `pub use` offers from elsewhere (`reexport`). */
function exports(source: string, limit = 80): ExportRef[] {
  const found: ExportRef[] = [], seen = new Set<string>();
  const add = (name: string | undefined, kind: ExportRef["kind"]) => { if (name && !seen.has(name) && found.length < limit) { seen.add(name); found.push({ name, kind }); } };
  const children = parser.parse(source).namedChildren;
  const offered: string[] = [];
  children.forEach((node, index) => {
    if (!node) return;
    const visible = node.namedChildren.some(child => child?.type === "visibility_modifier");
    if (node.type === "macro_definition" && attributesBefore(children, index).some(text => /macro_export/.test(text))) add(node.childForFieldName("name")?.text, "function");
    else if (visible && kinds[node.type]) add(node.childForFieldName("name")?.text, kinds[node.type]!);
    else if (visible && node.type === "use_declaration") {
      const leaves: string[] = [];
      const walk = (tree: Node | null) => {
        if (!tree) return;
        if (tree.type === "use_as_clause") leaves.push(tree.childForFieldName("alias")?.text ?? "");
        else if (tree.type === "scoped_identifier" || tree.type === "identifier") leaves.push(tree.text.split("::").at(-1)!);
        else if (tree.type === "scoped_use_list") walk(tree.childForFieldName("list"));
        else if (tree.type === "use_list") for (const child of tree.namedChildren) walk(child);
      };
      walk(node.childForFieldName("argument"));
      offered.push(...leaves.filter(name => name && name !== "_" && name !== "self"));
    }
  });
  for (const name of offered) add(name, "reexport");
  return found;
}

/** The item that declares a name: top-level, a method in an `impl` or a `trait`, or an item inside an inline module. */
function declared(source: string, name: string): Node | undefined {
  const search = (nodes: (Node | null)[], depth: number): Node | undefined => {
    for (const node of nodes) if (node && node.type !== "impl_item" && node.type !== "trait_item" && node.type !== "mod_item" && node.childForFieldName("name")?.text === name && (itemTypes.has(node.type) || node.type === "function_signature_item")) return node;
    if (depth > 3) return undefined;
    for (const node of nodes) {
      if (node?.type === "trait_item" && node.childForFieldName("name")?.text === name) return node;
      if (node?.type === "mod_item" && node.childForFieldName("name")?.text === name && !node.childForFieldName("body")) return node;
    }
    for (const node of nodes) {
      const body = node && (node.type === "impl_item" || node.type === "trait_item" || node.type === "mod_item") ? node.childForFieldName("body") : null;
      const inner = body ? search(body.namedChildren, depth + 1) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  return search(parser.parse(source).namedChildren, 0);
}

/** An item as it is declared, its body cut off: `pub async fn sync(settings: &Settings) -> Result<()>`, `pub struct Client`. */
function declaration(source: string, name: string): string | undefined {
  const node = declared(source, name);
  if (!node) return undefined;
  const clip = (text: string) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat; };
  if (node.type === "macro_definition") return `macro_rules! ${name}`;
  const body = node.childForFieldName("body");
  return clip(body ? source.slice(node.startIndex, body.startIndex) : node.text);
}
const declarationLine = (source: string, name: string) => { const node = declared(source, name); return node ? node.startPosition.row + 1 : undefined; };

type TargetKind = "lib" | "bin" | "build" | "test" | "example" | "bench";
interface Dependency { readonly name: string; readonly kind: "normal" | "dev" | "build"; readonly directory?: string }
interface Package {
  readonly directory: string; readonly libName: string; readonly edition: number;
  readonly dependencies: Map<string, Dependency[]>;
  readonly targets: { root: string; kind: TargetKind }[];
}
/** A module: the file that holds it, the inline modules it is inside that file (`[]` for the file's own), and whether it is test code. */
interface Module { readonly file: string; readonly scope: readonly string[]; readonly test: boolean }
interface Target { readonly kind: TargetKind; readonly package: Package; readonly modules: Map<string, Module>; readonly macros: Map<string, string> }
interface Context { readonly target: Target; readonly segments: readonly string[]; readonly test: boolean }

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : undefined;

/**
 * Crates: each `Cargo.toml` with a `[package]` is one, with its targets found as Cargo finds them (`src/lib.rs`, `src/main.rs`, `src/bin/`, the build
 * script, `examples/`, `tests/`, `benches/`, and what `[lib]`, `[[bin]]` and the rest declare), its dependencies (`workspace = true` read from the
 * workspace, `package = "…"` renames) and, from each target's root, its module tree. A path resolves segment by segment through that tree; the segment
 * after the last module is the name taken from the module's file.
 */
const resolver = Effect.fn("Scan.rust")(function* (workspace: Workspace) {
  const { paths, refs } = workspace;
  const listed = new Set(paths);
  const directory = (path: string) => posix.dirname(path) === "." ? "" : posix.dirname(path);
  const join_ = (...parts: string[]) => posix.normalize(parts.filter(Boolean).join("/") || ".").replace(/^\.$/, "");
  const inWorkspace = (path: string) => path !== ".." && !path.startsWith("../");
  const shapeOf = (path: string) => (refs.get(path)?.[0] as RustImport | undefined)?.shape;

  const manifests = new Map<string, Record<string, unknown>>();
  for (const path of paths.filter(item => /(^|\/)Cargo\.toml$/.test(item) && !vendored(item))) {
    const source = yield* workspace.read(path);
    try { if (source !== undefined) manifests.set(directory(path), record(Bun.TOML.parse(source))); } catch { /* A manifest that does not parse names no crate. */ }
  }
  const workspaceOf = (folder: string) => {
    for (let at = folder; ; at = directory(at)) { if (manifests.get(at)?.workspace) return { folder: at, table: record(manifests.get(at)!.workspace) }; if (!at) return undefined; }
  };

  const packages = new Map<string, Package>();
  for (const [folder, manifest] of manifests) {
    const table = record(manifest.package);
    const name = text(table.name);
    if (!name) continue;
    const root = workspaceOf(folder);
    const shared = record(root?.table.package);
    const editionValue = record(table.edition).workspace === true ? shared.edition : table.edition;
    const edition = Number(text(editionValue) ?? "2015");
    const sharedDependencies = record(root?.table.dependencies);
    const dependencies = new Map<string, Dependency[]>();
    const tables: [Record<string, unknown>, Dependency["kind"]][] = [];
    const collect = (holder: Record<string, unknown>) => {
      tables.push([record(holder.dependencies), "normal"], [record(holder["dev-dependencies"]), "dev"], [record(holder["build-dependencies"]), "build"]);
      tables.push([record(holder["dev_dependencies"]), "dev"], [record(holder["build_dependencies"]), "build"]);
    };
    collect(manifest);
    for (const target of Object.values(record(manifest.target))) collect(record(target));
    for (const [table, kind] of tables) for (const [entry, value] of Object.entries(table)) {
      let spec = record(value), base = folder;
      if (spec.workspace === true) { spec = { ...record(sharedDependencies[entry]), ...spec }; base = root?.folder ?? folder; }
      const path = text(spec.path);
      const target = path ? join_(base, path) : undefined;
      const dependency: Dependency = { name: text(spec.package) ?? entry, kind, ...target !== undefined && inWorkspace(target) ? { directory: target } : {} };
      // The name the code uses: the entry's own name when it renames a package, else the package's library name (for a crate of this workspace) or its name.
      const renamed = text(spec.package) !== undefined;
      const code = entry.replaceAll("-", "_");
      dependencies.set(code, [...dependencies.get(code) ?? [], dependency]);
      if (!renamed && dependency.directory !== undefined) {
        const library = text(record(manifests.get(dependency.directory)?.lib).name);
        if (library && library !== code) dependencies.set(library, [...dependencies.get(library) ?? [], dependency]);
      }
    }
    const inside = (path: string) => folder === "" || path.startsWith(`${folder}/`);
    const relative = (path: string) => folder ? path.slice(folder.length + 1) : path;
    const own = paths.filter(path => path.endsWith(".rs") && inside(path) && !vendored(path));
    const has = (path: string) => listed.has(path);
    const targets: { root: string; kind: TargetKind }[] = [];
    const add = (root: string | undefined, kind: TargetKind) => { if (root && has(root) && !targets.some(item => item.root === root)) targets.push({ root, kind }); };
    const lib = record(manifest.lib);
    add(text(lib.path) ? join_(folder, text(lib.path)!) : join_(folder, "src/lib.rs"), "lib");
    const declaredTargets = (field: string, kind: TargetKind, defaultDirectory: string) => {
      for (const entry of Array.isArray(manifest[field]) ? manifest[field] as unknown[] : []) {
        const item = record(entry), path = text(item.path), name = text(item.name);
        if (path) add(join_(folder, path), kind);
        else if (name) { add(join_(folder, defaultDirectory, `${name}.rs`), kind); add(join_(folder, defaultDirectory, name, "main.rs"), kind); if (kind === "bin") add(join_(folder, "src/main.rs"), kind); }
      }
    };
    declaredTargets("bin", "bin", "src/bin");
    declaredTargets("example", "example", "examples");
    declaredTargets("test", "test", "tests");
    declaredTargets("bench", "bench", "benches");
    const auto = (flag: string, kind: TargetKind, base: string) => {
      if (table[flag] === false) return;
      for (const path of own) {
        const rest = relative(path);
        if (new RegExp(`^${base}/[^/]+\\.rs$`).test(rest) || new RegExp(`^${base}/[^/]+/main\\.rs$`).test(rest)) add(path, kind);
      }
    };
    if (table.autobins !== false) add(join_(folder, "src/main.rs"), "bin");
    auto("autobins", "bin", "src/bin");
    auto("autoexamples", "example", "examples");
    auto("autotests", "test", "tests");
    auto("autobenches", "bench", "benches");
    if (table.build !== false) add(text(table.build) ? join_(folder, text(table.build)!) : join_(folder, "build.rs"), "build");
    packages.set(folder, { directory: folder, libName: (text(lib.name) ?? name).replaceAll("-", "_"), edition, dependencies, targets });
  }

  // Each target's module tree, and for each file the first target and module that reach it (a library before its binaries).
  const contexts = new Map<string, Context>();
  const libraries = new Map<string, Target>();
  const isModRs = (path: string, root: string) => path === root || ["mod.rs", "lib.rs", "main.rs"].includes(posix.basename(path));
  for (const pack of packages.values()) for (const { root, kind } of pack.targets) {
    const target: Target = { kind, package: pack, modules: new Map(), macros: new Map() };
    if (kind === "lib") libraries.set(pack.directory, target);
    // A file a `#[path]` attribute names owns the folder it sits in, as a `mod.rs` does: its own `mod x;` is the file beside it.
    const visit = (path: string, segments: readonly string[], test: boolean, depth: number, named = false) => {
      target.modules.set(key(segments), { file: path, scope: [], test });
      if (!contexts.has(path)) contexts.set(path, { target, segments, test });
      const shape = shapeOf(path);
      if (!shape || depth > 64) return;
      for (const name of shape.macros) if (!target.macros.has(name)) target.macros.set(name, path);
      const fileTest = test || shape.test;
      const base = named || isModRs(path, root) ? directory(path) : join_(directory(path), posix.basename(path, ".rs"));
      const scopes = [...shape.scopes.keys()].sort((a, b) => a.length - b.length);
      const testScopes = new Set<string>();
      for (const scopeKey of scopes) {
        const inner = scopeKey ? scopeKey.split("::") : [];
        const scopeTest = fileTest || testScopes.has(scopeKey);
        for (const mod of shape.scopes.get(scopeKey)!.mods) {
          const child = [...segments, ...inner, mod.name];
          const childTest = scopeTest || mod.test;
          if (mod.inline) {
            target.modules.set(key(child), { file: path, scope: [...inner, mod.name], test: childTest });
            if (childTest) testScopes.add(key([...inner, mod.name]));
            continue;
          }
          const folder = join_(base, ...inner);
          const candidates = mod.path ? [join_(inner.length ? folder : directory(path), mod.path)] : [join_(folder, `${mod.name}.rs`), join_(folder, mod.name, "mod.rs")];
          const found = candidates.find(item => listed.has(item) && !target.modules.has(key(child)));
          if (found && [...target.modules.values()].every(item => item.file !== found)) visit(found, child, childTest, depth + 1, mod.path !== undefined);
        }
      }
    };
    visit(root, [], kind === "test" || kind === "bench", 0);
  }
  // A file no `mod` reaches is read where it sits: its module is its place under `src/`, in its package's library (or first target).
  for (const path of paths) {
    if (!path.endsWith(".rs") || vendored(path) || contexts.has(path)) continue;
    const owner = [...packages.values()].filter(item => item.directory === "" || path.startsWith(`${item.directory}/`)).sort((a, b) => b.directory.length - a.directory.length)[0];
    const library = owner && (libraries.get(owner.directory) ?? undefined);
    if (!owner || !library) continue;
    const rest = (owner.directory ? path.slice(owner.directory.length + 1) : path).replace(/^src\//, "").replace(/(\/mod)?\.rs$/, "");
    contexts.set(path, { target: library, segments: rest.split("/").filter(Boolean), test: /(^|\/)(tests|benches)\//.test(path) });
  }

  const allowed = (kind: TargetKind, dependency: Dependency) => dependency.kind === "normal" || (dependency.kind === "dev" && ["test", "example", "bench"].includes(kind)) || (dependency.kind === "build" && kind === "build");
  const externalName = (name: string, rest: readonly string[]) => std.has(name) ? name : rest[0] ? `${name}/${rest[0]}` : name;

  /** Every file several readings reach (each `cfg` alternative of an alias), or the first answer when none reaches a file. */
  const merge = (results: Resolution[]): Resolution => {
    const files = new Map<string, { to: string; names?: ImportNames }>();
    for (const result of results) if (result && "files" in result) for (const entry of result.files) if (!files.has(entry.to)) files.set(entry.to, entry);
    return files.size ? { files: [...files.values()] } : results.find(result => result !== undefined);
  };

  /**
   * A glob from inside the module it names (`use super::*` in a child) also takes the module's private imports: each name the file writes that the
   * module brought in with a `use`, or with a glob of its own whose module declares it, is followed to where that `use` leads. One level deep.
   */
  const privateImports = (module: Module, names: readonly string[], depth: number) => {
    const files = new Map<string, string[]>();
    const scope = shapeOf(module.file)?.scopes.get(key(module.scope));
    const own = (refs.get(module.file) ?? []) as RustImport[];
    const globs = own.filter(item => item.glob && key(item.scope) === key(module.scope) && !item.shape);
    const globFiles = globs.flatMap(item => { const found = resolve(module.file, { ...item, names: "*" }, depth + 1); return found && "files" in found ? found.files.map(entry => entry.to) : []; });
    for (const name of names) {
      const aliases = scope?.aliases.get(name);
      const found = aliases ? merge(aliases.map(alias => resolve(module.file, { specifier: key(alias), line: 1, kind: "import", segments: alias, scope: module.scope, use: true, glob: false, names: [{ imported: alias.at(-1)!, exported: name }] }, depth + 1)))
        : undefined;
      const reached = found && "files" in found ? found.files.map(entry => entry.to) : globFiles.filter(file => workspace.declared.get(file)?.has(name));
      for (const file of reached) if (file !== module.file) files.set(file, [...files.get(file) ?? [], name]);
    }
    return [...files].map(([to, taken]) => ({ to, names: taken.map(name => ({ imported: name, exported: name })) }));
  };

  /** The module a path reaches in a target, and the name taken from it. `inside` is the importing module's path when it is in the same target. */
  const walk = (target: Target, from: string, base: readonly string[], rest: readonly string[], ref: RustImport, inside?: readonly string[], depth = 0): Resolution => {
    const at = [...base];
    if (!target.modules.has(key(at))) return { unresolved: "not-found" };
    let index = 0;
    while (index < rest.length && target.modules.has(key([...at, rest[index]!]))) at.push(rest[index++]!);
    const module = target.modules.get(key(at))!;
    if (module.test || module.file === from) return undefined;
    if (index < rest.length) {
      const name = rest[index]!;
      // `crate::name!`: an exported macro sits at the crate's root, declared wherever its file is.
      const macro = at.length === 0 ? target.macros.get(name) : undefined;
      if (macro && macro !== from) return { files: [{ to: macro }] };
      // A name the module brought in with a `use` (`use atuin_domain::api::ErrorResponse;` in the parent, then `crate::handlers::ErrorResponse` in a
      // child; `pub use atuin_client::theme;`, then `client::theme::Meaning`): the path continues from where that `use` leads. Code that compiles
      // names only what it can see, so the `use` is followed whatever its visibility.
      const through = depth < 4 ? shapeOf(module.file)?.scopes.get(key(module.scope))?.aliases.get(name)?.filter(path => path.at(-1) !== name || path.length > 1) : undefined;
      if (through?.length) {
        const found = merge(through.map(path => resolve(module.file, { ...ref, segments: [...path, ...rest.slice(index + 1)], scope: module.scope, use: true, glob: false }, depth + 1)));
        if (found && "files" in found) {
          // A module that declares the name itself under another `cfg` keeps its own file too.
          const own = shapeOf(module.file)?.scopes.get(key(module.scope))?.items.has(name) ? [{ to: module.file, names: [{ imported: name, exported: name }] }] : [];
          const files = [...own, ...found.files].filter((entry, at, all) => entry.to !== from && all.findIndex(other => other.to === entry.to) === at);
          return files.length ? { files } : undefined;
        }
      }
      return { files: [{ to: module.file, names: [{ imported: name, exported: index === rest.length - 1 ? ref.alias ?? name : name }] }] };
    }
    if (!ref.glob) return { files: [{ to: module.file }] };
    const names = Array.isArray(ref.names) && !ref.reexport ? ref.names as { imported: string; exported: string }[] : undefined;
    const extra = names && inside && depth < 2 && at.every((part, index) => inside[index] === part) ? privateImports(module, names.map(item => item.imported), depth) : [];
    return { files: [{ to: module.file, names: names ?? "*" }, ...extra.filter(entry => entry.to !== from)] };
  };

  const crate = (context: Context, from: string, name: string, rest: readonly string[], ref: RustImport, depth: number): Resolution | "none" => {
    const { target } = context;
    const shape = shapeOf(target.modules.get("")?.file ?? from);
    const external = shape?.externs.get(name) ?? shapeOf(from)?.externs.get(name);
    if (external && external !== name && depth < 6) return crate(context, from, external, rest, ref, depth + 1);
    if (std.has(name)) return { external: name };
    const dependency = (target.package.dependencies.get(name) ?? []).find(item => allowed(target.kind, item));
    if (dependency) {
      const library = dependency.directory !== undefined ? libraries.get(dependency.directory) : undefined;
      return library ? walk(library, from, [], rest, ref, undefined, depth) : { external: externalName(dependency.name, rest) };
    }
    if (name === target.package.libName && target.kind !== "lib") {
      const library = libraries.get(target.package.directory);
      if (library) return walk(library, from, [], rest, ref, undefined, depth);
    }
    if (external) return { external: externalName(external, rest) };
    return "none";
  };

  const resolve = (from: string, ref: RustImport, depth: number): Resolution => {
    if (ref.shape) return undefined;
    const context = contexts.get(from);
    const segments = ref.segments;
    const first = segments[0]!;
    if (!context) return ref.use && segments.length ? std.has(first) || first === "::" ? undefined : { external: externalName(first, segments.slice(1)) } : undefined;
    if (context.test || shapeOf(from)?.test) return undefined;
    const { target } = context;
    const current = [...context.segments, ...ref.scope];
    if (first === "crate") return walk(target, from, [], segments.slice(1), ref, current, depth);
    if (first === "self") return walk(target, from, current, segments.slice(1), ref, current, depth);
    if (first === "super") {
      let up = 0;
      while (segments[up] === "super") up++;
      if (up > current.length) return { unresolved: "not-found" };
      return walk(target, from, current.slice(0, current.length - up), segments.slice(up), ref, current, depth);
    }
    // In edition 2015 a `use` path, and any path after `::`, starts at the crate's root.
    const old = target.package.edition < 2018;
    if (old && (first === "::" ? segments[1] !== undefined && target.modules.has(key([segments[1]])) : ref.use && target.modules.has(key([first])))) {
      return walk(target, from, [], first === "::" ? segments.slice(1) : segments, ref, current, depth);
    }
    if (first === "::") {
      const found = segments[1] ? crate(context, from, segments[1], segments.slice(2), ref, depth) : "none";
      return found === "none" ? ref.use && segments[1] ? { external: externalName(segments[1], segments.slice(2)) } : undefined : found;
    }
    // From 2018 on, a path starts where the code is: a module declared here, then a name a `use` brought here, then an item of this module, then a crate.
    if (target.modules.has(key([...current, first]))) return walk(target, from, current, segments, ref, current, depth);
    const scope = shapeOf(from)?.scopes.get(key(ref.scope));
    const aliases = (scope?.aliases.get(first) ?? []).filter(alias => alias[0] !== first);
    if (aliases.length && depth < 4 && !(ref.use && segments.length === 1)) {
      // The name stands for the path its `use` wrote, which resolves as a `use` does (from the crate root in edition 2015).
      return merge(aliases.map(alias => resolve(from, { ...ref, segments: [...alias, ...segments.slice(1)], use: true }, depth + 1)));
    }
    // `use a;` then `a::f()`: the path is the use's own.
    if (scope?.aliases.get(first)?.some(alias => alias[0] === first) && !ref.use && depth < 4) return resolve(from, { ...ref, use: true }, depth + 1);
    if (scope?.items.has(first)) return undefined;
    const found = crate(context, from, first, segments.slice(1), ref, depth);
    if (found !== "none") return found;
    return ref.use ? { external: externalName(first, segments.slice(1)) } : undefined;
  };
  return (from: string, ref: ImportRef): Resolution => resolve(from, ref as RustImport, 0);
});

export const rust: FrontEnd = { languages: { ".rs": "rust" }, load: parser.load, imports, exports, declaration, declarationLine, resolver, skips: vendored };
