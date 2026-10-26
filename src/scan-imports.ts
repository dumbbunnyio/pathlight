export type ImportKind = "import" | "type" | "reexport" | "dynamic" | "require";
export interface ImportRef { readonly specifier: string; readonly line: number; readonly kind: ImportKind }

type Token = { readonly kind: "word" | "punct" | "string"; readonly text: string; readonly line: number };

// A `/` after one of these starts a regular expression, not a division.
const regexAfterPunct = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const regexAfterWord = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new", "yield", "await"]);
const identifier = /[\p{ID_Start}$_]/u, identifierPart = /[\p{ID_Continue}$‌‍]/u;

/**
 * The significant tokens of a JavaScript or TypeScript file: words, punctuation and string literals. Comments, template
 * literal bodies and regular expressions are skipped, so text that only looks like an import never counts as one.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0, line = 1;
  // A shebang is the first line of an executable script, not code.
  if (source.startsWith("#!")) while (index < source.length && source[index] !== "\n") index++;
  const last = () => tokens.at(-1);
  // Skips a template literal starting after its opening backtick, including nested `${ ... }` expressions.
  const skipTemplate = () => {
    while (index < source.length) {
      const char = source[index]!;
      if (char === "\n") line++;
      if (char === "\\") { index += 2; continue; }
      if (char === "`") { index++; return; }
      if (char === "$" && source[index + 1] === "{") {
        index += 2;
        for (let depth = 1; index < source.length && depth > 0;) {
          const inner = source[index]!;
          if (inner === "\n") line++;
          if (inner === "`") { index++; skipTemplate(); continue; }
          if (inner === "'" || inner === '"') { skipString(inner); continue; }
          if (inner === "{") depth++;
          else if (inner === "}") depth--;
          index++;
        }
        continue;
      }
      index++;
    }
  };
  const skipString = (quote: string) => {
    index++;
    while (index < source.length && source[index] !== quote && source[index] !== "\n") index += source[index] === "\\" ? 2 : 1;
    index++;
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") { line++; index++; continue; }
    if (/\s/.test(char)) { index++; continue; }
    if (char === "/" && source[index + 1] === "/") { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) { if (source[index] === "\n") line++; index++; }
      index += 2;
      continue;
    }
    if (char === "`") { index++; skipTemplate(); tokens.push({ kind: "punct", text: "`", line }); continue; }
    if (char === "'" || char === '"') {
      const start = index + 1, startLine = line;
      skipString(char);
      tokens.push({ kind: "string", text: source.slice(start, index - 1), line: startLine });
      continue;
    }
    if (char === "/") {
      const before = last();
      const regex = !before || (before.kind === "punct" && regexAfterPunct.has(before.text)) || (before.kind === "word" && regexAfterWord.has(before.text));
      if (regex) {
        index++;
        for (let inClass = false; index < source.length && source[index] !== "\n"; index++) {
          if (source[index] === "\\") { index++; continue; }
          if (source[index] === "[") inClass = true;
          else if (source[index] === "]") inClass = false;
          else if (source[index] === "/" && !inClass) break;
        }
        index++;
        while (index < source.length && identifierPart.test(source[index]!)) index++;
        tokens.push({ kind: "punct", text: "regex", line });
        continue;
      }
    }
    if (identifier.test(char)) {
      const start = index;
      while (index < source.length && identifierPart.test(source[index]!)) index++;
      tokens.push({ kind: "word", text: source.slice(start, index), line });
      continue;
    }
    tokens.push({ kind: "punct", text: char, line });
    index++;
  }
  return tokens;
}

/**
 * Every module specifier a file names with a literal: `import`, `import type`, `export … from`, `import("x")` and
 * `require("x")`, in source order, each with the line its statement starts on. Specifiers built at run time cannot
 * be read statically and are not reported.
 */
export function importsOf(source: string): ImportRef[] {
  const tokens = tokenize(source);
  const found: ImportRef[] = [];
  const at = (index: number) => tokens[index];
  const is = (index: number, text: string) => at(index)?.text === text && at(index)?.kind !== "string";
  // The clause between `import`/`export` and `from "x"`: only words and the punctuation of named bindings may appear.
  const clauseEnd = (start: number) => {
    // The clause ends at the first token that cannot be part of it, so this bound only stops a pathological file; generated code lists hundreds of names.
    for (let index = start; index < tokens.length && index < start + 50_000; index++) {
      const token = tokens[index]!;
      if (token.kind === "word" && token.text === "from" && at(index + 1)?.kind === "string") return index;
      const allowed = token.kind === "word" || (token.kind === "punct" && ["{", "}", ",", "*"].includes(token.text));
      if (!allowed) return -1;
    }
    return -1;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "word" || is(index - 1, ".")) continue;
    if (token.text === "import") {
      const next = at(index + 1);
      if (next?.kind === "string") { found.push({ specifier: next.text, line: token.line, kind: "import" }); continue; }
      if (is(index + 1, "(") && at(index + 2)?.kind === "string" && (is(index + 3, ")") || is(index + 3, ","))) {
        found.push({ specifier: at(index + 2)!.text, line: token.line, kind: "dynamic" });
        continue;
      }
      const typeOnly = is(index + 1, "type") && !(is(index + 2, "from") && at(index + 3)?.kind === "string");
      const end = clauseEnd(index + 1);
      if (end < 0) continue;
      // `import { type A, type B } from` imports no value either: every named binding carries its own `type`.
      const clause = tokens.slice(index + 1, end);
      const open = clause.findIndex(item => item.text === "{");
      const named: Token[][] = [[]];
      if (open === 0) for (const item of clause.slice(1)) { if (item.text === "}") break; if (item.text === ",") named.push([]); else named.at(-1)!.push(item); }
      const bindings = named.filter(parts => parts.length > 0);
      const inlineTypes = open === 0 && bindings.length > 0 && bindings.every(parts => parts[0]!.text === "type" && parts.length > 1 && parts[1]!.text !== "as");
      found.push({ specifier: at(end + 1)!.text, line: token.line, kind: typeOnly || inlineTypes ? "type" : "import" });
      index = end + 1;
    } else if (token.text === "export") {
      const typeOnly = is(index + 1, "type") && (is(index + 2, "{") || is(index + 2, "*"));
      const start = index + 1 + (typeOnly ? 1 : 0);
      if (!is(start, "{") && !is(start, "*")) continue;
      const end = clauseEnd(start);
      if (end < 0) continue;
      found.push({ specifier: at(end + 1)!.text, line: token.line, kind: typeOnly ? "type" : "reexport" });
      index = end + 1;
    } else if (token.text === "require" && is(index + 1, "(") && at(index + 2)?.kind === "string" && is(index + 3, ")")) {
      found.push({ specifier: at(index + 2)!.text, line: token.line, kind: "require" });
    }
  }
  return found;
}

export type ExportKind = "function" | "class" | "interface" | "type" | "enum" | "const" | "namespace" | "default" | "named" | "reexport";
export interface ExportRef { readonly name: string; readonly kind: ExportKind }

/** Names a file offers to others, read from its `export` statements: what a file is called says little, what it defines says more. Names only, in order, at most `limit`. */
export function exportsOf(source: string, limit = 80): ExportRef[] {
  const tokens = tokenize(source);
  const found: ExportRef[] = [];
  const word = (index: number) => tokens[index]?.kind === "word" ? tokens[index]!.text : undefined;
  const is = (index: number, text: string) => tokens[index]?.text === text && tokens[index]?.kind !== "string";
  const modifiers = new Set(["declare", "abstract", "async", "const"]);
  for (let index = 0; index < tokens.length && found.length < limit; index++) {
    if (word(index) !== "export" || is(index - 1, ".")) continue;
    let at = index + 1;
    if (word(at) === "default") {
      let next = at + 1;
      while (word(next) === "async" || word(next) === "abstract") next++;
      const keyword = word(next);
      const name = keyword === "function" || keyword === "class" ? (is(next + 1, "*") ? word(next + 2) : word(next + 1)) : undefined;
      found.push({ name: name && name !== "extends" && name !== "implements" ? `default (${name})` : "default", kind: "default" });
      continue;
    }
    if (is(at, "*")) {
      // `export * from "x"` and `export * as ns from "x"`.
      const alias = word(at + 1) === "as" ? word(at + 2) : undefined;
      if (alias) found.push({ name: alias, kind: "reexport" });
      continue;
    }
    const typeOnly = word(at) === "type" && is(at + 1, "{");
    if (typeOnly) at++;
    if (is(at, "{")) {
      // `export { a, b as c, type d } [from "x"]`: the names other files see.
      const fromModule = (() => { for (let end = at; end < tokens.length && end < at + 5_000; end++) if (is(end, "}")) return word(end + 1) === "from"; return false; })();
      for (let item = at + 1; item < tokens.length && !is(item, "}") && found.length < limit; item++) {
        let name = word(item);
        if (!name) continue;
        if (name === "type" && word(item + 1) && !is(item + 1, ",") && word(item + 1) !== "as") name = word(++item)!;
        if (word(item + 1) === "as") { name = word(item + 2) ?? name; item += 2; }
        found.push({ name, kind: fromModule ? "reexport" : typeOnly ? "type" : "named" });
        while (item < tokens.length && !is(item, ",") && !is(item, "}")) item++;
        if (is(item, "}")) break;
      }
      continue;
    }
    while (modifiers.has(word(at) ?? "") && !(word(at) === "const" && word(at + 1) !== "enum")) at++;
    const keyword = word(at);
    if (keyword === "function") { const name = is(at + 1, "*") ? word(at + 2) : word(at + 1); if (name) found.push({ name, kind: "function" }); }
    else if (keyword === "class") { const name = word(at + 1); if (name) found.push({ name, kind: "class" }); }
    else if (keyword === "interface" || keyword === "type" || keyword === "enum" || keyword === "namespace") {
      const name = word(at + 1);
      if (name) found.push({ name, kind: keyword === "namespace" ? "namespace" : keyword });
    } else if (keyword === "const" || keyword === "let" || keyword === "var") {
      const name = word(at + 1);
      if (name) found.push({ name, kind: "const" });
    }
  }
  return found;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a file declares for an exported name, as it is written: the line or lines of the `export` statement up to where its body begins, whitespace
 * collapsed and cut at 240 characters. Nothing is inferred (no resolved types); a declaration that cannot be found returns undefined.
 */
const declarationPattern = (name: string) =>
  new RegExp(`^[ \\t]*export\\s+(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|interface|type|enum|namespace|const|let|var)\\s+${escapeRegExp(name)}\\b`, "m");

/** The 1-based line an exported name is declared on, as the file reads now. */
export function declarationLine(source: string, name: string): number | undefined {
  const match = declarationPattern(name).exec(source);
  return match ? source.slice(0, match.index).split("\n").length : undefined;
}

export function declarationOf(source: string, name: string): string | undefined {
  const match = declarationPattern(name).exec(source);
  if (!match) return undefined;
  const rest = source.slice(match.index);
  // The body starts at the first `{` after the parameters (or at `=>`, or the end of a statement), so only the signature is kept.
  let depth = 0, end = rest.length;
  for (let index = 0; index < Math.min(rest.length, 1_500); index++) {
    const char = rest[index]!;
    if (char === "(" || char === "[" || char === "<") depth++;
    else if (char === ")" || char === "]" || (char === ">" && rest[index - 1] !== "=")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ";" || (char === "=" && rest[index + 1] === ">"))) { end = char === ";" ? index : index + 2; break; }
    else if (depth === 0 && char === "{" && !/:\s*$/.test(rest.slice(Math.max(0, index - 3), index)) && !/[:|&=,]\s*$/.test(rest.slice(0, index))) { end = index; break; }
  }
  const text = rest.slice(0, end).replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}
