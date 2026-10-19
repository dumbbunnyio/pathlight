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
    for (let index = start; index < tokens.length && index < start + 400; index++) {
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
