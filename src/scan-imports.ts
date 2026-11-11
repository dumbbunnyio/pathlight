import { callsThrough, strongest, usesOf, type Binding, type How, type Occurrence, type Use } from "./uses";

export type ImportKind = "import" | "type" | "reexport" | "dynamic" | "require";
/**
 * The names a statement takes from the module it names: `imported` is the name in that module (`default` for a default import), `exported` the name it is
 * offered under again (for `export … from`; an import's own name otherwise). `"*"` is the whole module (`import * as`, `export *`). Absent when the statement
 * names nothing (`import "x"`, `import("x")`, `require("x")`).
 */
export type ImportNames = "*" | readonly { readonly imported: string; readonly exported: string }[];
/** `reexport` marks `export … from` (including `export type … from`): the file offers those names on, so an import of them can be followed through it. */
export interface ImportRef {
  readonly specifier: string; readonly line: number; readonly kind: ImportKind; readonly names?: ImportNames; readonly reexport?: true;
  /** How the file uses what this import brings in (`src/uses.ts`). Absent when the front end does not read uses for it. */
  readonly uses?: readonly Use[];
}

type Token = { readonly kind: "word" | "punct" | "string"; readonly text: string; readonly line: number };

// A `/` after one of these starts a regular expression, not a division.
const regexAfterPunct = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const regexAfterWord = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new", "yield", "await"]);
const identifier = /[\p{ID_Start}$_]/u, identifierPart = /[\p{ID_Continue}$‌‍]/u;

/**
 * The significant tokens of a JavaScript or TypeScript file: words, punctuation and string literals. Comments, the text of template literals and
 * regular expressions are skipped, so text that only looks like an import never counts as one. A template's `${ … }` expressions are code and are
 * read as tokens, wrapped in `(` and `)`; the template itself leaves one `` ` `` token after it.
 */
function tokenize(source: string, jsxMode = false): Token[] {
  const tokens: Token[] = [];
  let index = 0, line = 1;
  // A shebang is the first line of an executable script, not code.
  if (source.startsWith("#!")) while (index < source.length && source[index] !== "\n") index++;
  const last = () => tokens.at(-1);
  // Each open `${ … }` of a template, or `{ … }` inside JSX, with the brace depth it started at: its closing `}` returns to the template's text or to
  // the JSX it was in. JSX elements open in the current expression are a stack of where each one is: its tag (attributes) or its children (text).
  type Phase = "tag" | "children";
  const resumes: ({ depth: number; kind: "template" } | { depth: number; kind: "jsx"; elements: Phase[] })[] = [];
  let braces = 0, elements: Phase[] = [];
  const punct = (text: string) => tokens.push({ kind: "punct", text, line });
  const enter = (kind: "template" | "jsx") => {
    punct("(");
    resumes.push(kind === "template" ? { depth: braces++, kind } : { depth: braces++, kind, elements });
    if (kind === "jsx") elements = [];
  };
  const newline = () => { if (source[index] === "\n") line++; index++; };
  // A JSX tag's name (`Button`, `Menu.Item`, `svg:path`): its identifiers are words, the only part of a tag that can use an import.
  const tagName = () => {
    const start = index;
    while (index < source.length && /[\p{ID_Continue}$.:\-]/u.test(source[index]!)) index++;
    source.slice(start, index).split(".").forEach((part, at) => { if (at) punct("."); const word = /^[\p{ID_Start}$_][\p{ID_Continue}$]*/u.exec(part)?.[0]; if (word) tokens.push({ kind: "word", text: word, line }); });
  };
  // Reads JSX until the outermost element closes or an expression `{` opens. Attribute names, strings and text are skipped.
  const jsx = () => {
    while (index < source.length && elements.length) {
      const char = source[index]!;
      if (elements.at(-1) === "tag") {
        if (char === "/" && source[index + 1] === ">") { index += 2; elements.pop(); }
        else if (char === ">") { index++; elements[elements.length - 1] = "children"; }
        else if (char === "{") { index++; enter("jsx"); return; }
        else if (char === '"' || char === "'") { index++; while (index < source.length && source[index] !== char) newline(); index++; }
        // A comment between attributes.
        else if (char === "/" && source[index + 1] === "/") { while (index < source.length && source[index] !== "\n") index++; }
        else if (char === "/" && source[index + 1] === "*") { index += 2; while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) newline(); index += 2; }
        else if (char === "<" && /=\s*$/.test(source.slice(Math.max(0, index - 8), index))) { index++; punct("<"); tagName(); elements.push("tag"); }
        // A generic element's type arguments, `<List<Item> …>`: skipped.
        else if (char === "<") { for (let depth = 0; index < source.length;) { if (source[index] === "<") depth++; else if (source[index] === ">" && --depth === 0) { index++; break; } newline(); } }
        else newline();
        continue;
      }
      if (char === "{") { index++; enter("jsx"); return; }
      if (char === "<" && source[index + 1] === "/") { while (index < source.length && source[index] !== ">") newline(); index++; elements.pop(); continue; }
      if (char === "<") { index++; punct("<"); tagName(); elements.push("tag"); continue; }
      newline();
    }
  };
  // In a JSX file, `<` where an expression starts opens an element, unless it is a generic arrow function's `<T,>` or `<T extends …>`.
  const startsElement = () => {
    const before = last();
    const expression = !before || (before.kind === "punct" && ![")", "]", "}", "regex", "`"].includes(before.text)) || (before.kind === "word" && regexAfterWord.has(before.text));
    if (!jsxMode || !expression || !(identifier.test(source[index + 1] ?? "") || source[index + 1] === ">")) return false;
    const saved = { index, line, length: tokens.length };
    index++;
    punct("<");
    tagName();
    let probe = index;
    while (/\s/.test(source[probe] ?? "")) probe++;
    // A generic function type, `type F = <T>(x: T) => T`, `(cb: <T>(x: T) => T)` or an optional method `open?<T>(…)`, is not an element.
    const typeStatement = () => { for (let at = saved.length - 1; at >= Math.max(0, saved.length - 12); at--) { const token = tokens[at]!; if (token.kind === "punct" && [";", "{", "}"].includes(token.text)) return false; if (token.kind === "word" && token.text === "type") return true; } return false; };
    const functionType = source[probe] === ">" && /^>\s*\(/.test(source.slice(probe, probe + 40)) && (before?.text === ":" || (before?.text === "=" && typeStatement()) || (before?.text === "?" && source[saved.index - 1] === "?"));
    if (source[probe] === "," || /^extends\b/.test(source.slice(probe, probe + 8)) || functionType) { index = saved.index; line = saved.line; tokens.length = saved.length; return false; }
    elements.push("tag");
    jsx();
    return true;
  };
  // Reads a template literal's text from just after a backtick or an expression's `}`: to its end (true) or to the next `${` (false).
  const templateText = () => {
    while (index < source.length) {
      const char = source[index]!;
      if (char === "\n") line++;
      if (char === "\\") { index += 2; continue; }
      if (char === "`") { index++; tokens.push({ kind: "punct", text: "`", line }); return; }
      if (char === "$" && source[index + 1] === "{") {
        index += 2;
        enter("template");
        return;
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
    if (char === "`") { index++; templateText(); continue; }
    if (char === "<" && startsElement()) continue;
    if (char === "{") braces++;
    if (char === "}") {
      braces = Math.max(0, braces - 1);
      const resume = resumes.at(-1);
      if (resume && resume.depth === braces) {
        resumes.pop();
        index++;
        punct(")");
        if (resume.kind === "template") templateText();
        else { elements = resume.elements; jsx(); }
        continue;
      }
    }
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

/** The names an import or re-export clause takes (the tokens between `import`/`export` and `from`, a leading `type` removed). */
function importedNames(clause: readonly Token[], reexport: boolean): ImportNames {
  const names: { imported: string; exported: string }[] = [];
  let index = 0;
  // `* as ns`: the whole module, under one name. A namespace import cannot be followed name by name.
  if (clause[0]?.text === "*") return reexport && clause[1]?.text === "as" && clause[2] ? [{ imported: "*", exported: clause[2].text }] : "*";
  // A default import comes first: `import X from`, `import X, { a } from`, `import X, * as ns from`.
  if (clause[0]?.kind === "word" && clause[0].text !== "type") {
    names.push({ imported: "default", exported: clause[0].text });
    index = clause[1]?.text === "," ? 2 : 1;
    if (clause[index]?.text === "*") return "*";
  }
  if (clause[index]?.text === "{") {
    let parts: Token[] = [];
    const take = () => {
      const words = parts[0]?.text === "type" && parts.length > 1 && parts[1]!.text !== "as" ? parts.slice(1) : parts;
      if (words[0]) names.push({ imported: words[0].text, exported: words[1]?.text === "as" && words[2] ? words[2].text : words[0].text });
      parts = [];
    };
    for (const item of clause.slice(index + 1)) { if (item.text === "}") break; if (item.text === ",") take(); else parts.push(item); }
    take();
  }
  return names;
}

/** The local names an import clause binds (the tokens between `import` and `from`), each tied to the import at `ref`. */
function bindingsOf(clause: readonly Token[], typeOnly: boolean): Binding[] {
  const found: Binding[] = [];
  let index = 0;
  if (clause[0]?.kind === "word" && clause[0].text !== "type") {
    found.push({ local: clause[0].text, imported: "default", namespace: false, typeOnly });
    index = clause[1]?.text === "," ? 2 : 1;
  }
  if (clause[index]?.text === "*" && clause[index + 1]?.text === "as" && clause[index + 2]) found.push({ local: clause[index + 2]!.text, imported: "*", namespace: true, typeOnly });
  else if (clause[index]?.text === "{") {
    let parts: Token[] = [];
    const take = () => {
      const inline = parts[0]?.text === "type" && parts.length > 1 && parts[1]!.text !== "as";
      const words = inline ? parts.slice(1) : parts;
      if (words[0]) found.push({ local: words[1]?.text === "as" && words[2] ? words[2].text : words[0].text, imported: words[0].text, namespace: false, typeOnly: typeOnly || inline });
      parts = [];
    };
    for (const item of clause.slice(index + 1)) { if (item.text === "}") break; if (item.text === ",") take(); else parts.push(item); }
    take();
  }
  return found;
}

// Words after which a token starts an expression rather than ending one.
const operators = new Set(["return", "typeof", "new", "case", "extends", "implements", "keyof", "in", "of", "instanceof", "as", "satisfies", "is", "infer",
  "void", "delete", "throw", "yield", "await", "else", "do", "export", "default", "let", "var", "type", "interface", "function", "class", "import", "from",
  "unique", "asserts", "declare", "abstract", "readonly"]);
// Words that continue a type on the next line instead of starting a statement.
const typeContinuers = new Set(["extends", "is", "keyof", "typeof", "infer", "readonly", "unique", "asserts", "in"]);
const closesOperand = (token: Token | undefined) => !!token && (token.kind === "string" || (token.kind === "word" && !operators.has(token.text))
  || [")", "]", "}", ">", "regex", "`"].includes(token.text));
// Inside a type every word ends an operand (`void`, `string`, a name) except the operators of types.
const closesType = (token: Token | undefined) => !!token && (token.kind === "string" || (token.kind === "word" && !typeContinuers.has(token.text) && token.text !== "as")
  || [")", "]", "}", ">"].includes(token.text));
const declaring = new Set(["let", "const", "var"]);

interface Frame { readonly open: string; readonly type: boolean; readonly kind: "class" | "other"; ternary: number }
interface Run { readonly depth: number; readonly kind: "annotation" | "return" | "alias" | "as" | "heritage" | "block"; opened?: boolean; readonly owner?: string; readonly start?: number }

/**
 * Where each binding appears and how it is used, from the tokens alone. Type positions are tracked with a small state machine: annotations (a `:` in
 * a parameter list, after `)`, on a class member or a `let`), `type X =`, `interface`, `implements`, `as` and `satisfies`, generic arguments of a call,
 * and type literals inside them. A position it cannot place counts as a value (`references`), so a doubt keeps the arrow; `tests/eval/facts-uses.ts`
 * measures it against what TypeScript itself removes at emit.
 */
function occurrencesOf(tokens: readonly Token[], bindings: ReadonlyMap<string, Binding>, skip: ReadonlySet<number>, jsx: boolean): Occurrence[] {
  const found: Occurrence[] = [];
  const typed = new Map<string, Set<string>>(), called = new Map<string, Set<string>>();
  const stack: Frame[] = [{ open: "", type: false, kind: "other", ternary: 0 }];
  // The depth of a `class` keyword whose body has not opened yet: its body is the first `{` at that depth (a head can hold `({ … })`).
  let run: Run | undefined, pendingClass: number | undefined, extending = false;
  const classHead = () => pendingClass !== undefined && stack.length === pendingClass;
  const at = (index: number) => tokens[index];
  const is = (index: number, text: string) => at(index)?.text === text && at(index)?.kind !== "string";
  const top = () => stack.at(-1)!;
  const inType = () => run !== undefined || top().type;
  const statementStart = (index: number) => { const before = at(index - 1); return !before || [";", "}", "{"].includes(before.text) || ["export", "declare", "default"].includes(before.text) || before.line < at(index)!.line; };
  const push = (open: string, type: boolean, kind: Frame["kind"] = "other") => stack.push({ open, type, kind, ternary: 0 });
  const pop = () => {
    if (stack.length > 1) stack.pop();
    if (run && (stack.length < run.depth || (run.kind === "block" && run.opened && stack.length === run.depth))) run = undefined;
  };
  // A `<` that opens type arguments: it closes with a `>` followed by `(` or a template (a generic call), or it follows a class or function name.
  const typeArguments = (index: number) => {
    for (let at_ = index + 1, depth = 1; at_ < tokens.length && at_ < index + 200; at_++) {
      const token = tokens[at_]!;
      if (token.kind !== "punct") continue;
      // A statement's end, an assignment, a logical operator or a ternary: a comparison, not type arguments (`a < b && c > (d)`).
      if (token.text === ";" || (token.text === "=" && !is(at_ + 1, ">")) || (token.text === "&" && is(at_ + 1, "&")) || (token.text === "|" && is(at_ + 1, "|")) || token.text === "?") return false;
      if (token.text === "<") depth++;
      else if (token.text === ">" && !is(at_ - 1, "=")) { if (--depth === 0) return is(at_ + 1, "(") || is(at_ + 1, "`") || pendingClass !== undefined || is(index - 2, "function"); }
    }
    return false;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!, before = at(index - 1);
    if (skip.has(index)) continue;
    // A type that runs on to the next line ends where a new statement starts (no semicolons).
    if (run && run.kind !== "block" && stack.length === run.depth && before && token.line > before.line && closesType(before)
      && !(token.kind === "word" && typeContinuers.has(token.text)) && !(token.kind === "punct" && ["|", "&", ".", "<", "[", "=", ">", "?", ":", ",", ";", ")", "]", "}", "{"].includes(token.text))) run = undefined;
    if (token.kind === "punct") {
      const text = token.text;
      if (text === "=" && is(index + 1, ">")) {
        // An arrow ends a return type, and an annotation unless it follows a parameter list (a function type).
        if (run && stack.length === run.depth && (run.kind === "return" || (run.kind === "annotation" || run.kind === "as") && before?.text !== ")")) run = undefined;
        index++;
        continue;
      }
      if (run && stack.length === run.depth) {
        // A logical operator ends an `as` or an annotation's type: `env.PORT as string || DEFAULT`.
        const logical = ((text === "|" && is(index + 1, "|")) || (text === "&" && is(index + 1, "&"))) && (run.kind === "as" || run.kind === "annotation" || run.kind === "return");
        if (logical || text === ";" || (text === "," && run.kind !== "heritage" && run.kind !== "alias" && run.kind !== "block")
          || (text === "=" && (run.kind === "annotation" || run.kind === "return" || run.kind === "as"))
          || ((text === ":" || text === "?") && (run.kind === "annotation" || run.kind === "return" || run.kind === "as"))) { run = undefined; }
        else if (text === "{") {
          if (run.kind === "block") { push("{", true); run.opened = true; continue; }
          if (run.kind === "heritage" || closesType(before)) run = undefined;
          else { push("{", true); continue; }
        }
      }
      if (text === "(" || text === "[") { push(text, inType()); continue; }
      if (text === "{") { const body = classHead() && !inType(); push("{", inType(), body ? "class" : "other"); if (body) pendingClass = undefined; continue; }
      if (text === ")" || text === "]" || text === "}") { pop(); continue; }
      if (text === "<") {
        if (inType()) { push("<", true); continue; }
        const next = at(index + 1);
        // An element: `<` where a value starts (after `=>` too, whose `>` ends nothing). Its tag name is read here, once.
        if (jsx && next?.kind === "word" && (!closesOperand(before) || (before?.text === ">" && is(index - 2, "=")))) {
          const binding = bindings.get(next.text);
          const member = is(index + 2, ".") && at(index + 3)?.kind === "word" ? at(index + 3)!.text : undefined;
          if (binding) found.push({ local: next.text, ...binding.namespace && member ? { member } : {}, how: "renders" });
          index += member ? 3 : 1;
          continue;
        }
        if (typeArguments(index)) push("<", true);
        continue;
      }
      if (text === ">") { if (top().open === "<") pop(); continue; }
      if (text === "?" && !inType()) {
        if (!is(index + 1, ":") && !is(index + 1, ".") && !is(index + 1, "?") && !is(index + 1, ")") && !is(index + 1, ",") && !is(index + 1, "=") && !is(index - 1, "?")) top().ternary++;
        continue;
      }
      if (text === ":" && !inType()) {
        const frame = top();
        if (frame.ternary > 0) { frame.ternary--; continue; }
        const owner = before?.text === "?" || before?.text === "!" ? at(index - 2) : before;
        const annotation = before?.text === ")" || frame.open === "(" || frame.kind === "class"
          || (owner?.kind === "word" && declaring.has(at(index - (owner === before ? 2 : 3))?.text ?? ""));
        if (annotation) run = { depth: stack.length, kind: before?.text === ")" ? "return" : "annotation", start: index, ...owner?.kind === "word" ? { owner: owner.text } : {} };
        continue;
      }
      continue;
    }
    if (token.kind !== "word") continue;
    const word = token.text;
    // A property (`a.name`), not a spread (`...name`).
    if (is(index - 1, ".") && !is(index - 2, ".")) {
      // `this.db.query(…)`: a member called on a field.
      if (is(index - 2, "this") && is(index + 1, ".") && at(index + 2)?.kind === "word" && is(index + 3, "(")) (called.get(word) ?? called.set(word, new Set()).get(word)!).add(at(index + 2)!.text);
      continue;
    }
    // A keyword followed by `:` is an object's key or a label (`{ class: "image" }`).
    if (!inType() && !is(index + 1, ":")) {
      if (word === "class") { pendingClass = stack.length; continue; }
      if (word === "interface" && at(index + 1)?.kind === "word" && statementStart(index)) { run = { depth: stack.length, kind: "block" }; continue; }
      if (word === "declare" && ["module", "global", "namespace"].includes(at(index + 1)?.text ?? "")) { run = { depth: stack.length, kind: "block" }; continue; }
      if (word === "type" && statementStart(index) && at(index + 1)?.kind === "word" && (is(index + 2, "=") || is(index + 2, "<"))) { run = { depth: stack.length, kind: "alias" }; continue; }
      if (word === "type" && is(index - 1, "export") && is(index + 1, "{")) { run = { depth: stack.length, kind: "block" }; continue; }
      if (word === "implements") { run = { depth: stack.length, kind: "heritage" }; continue; }
      if (word === "extends" && classHead()) { extending = true; continue; }
      if ((word === "as" || word === "satisfies") && closesOperand(before)) { run = { depth: stack.length, kind: "as" }; continue; }
    }
    const binding = bindings.get(word);
    const extended = extending;
    extending = false;
    if (!binding) {
      // A member called on a local: `db.query(…)`, `db?.query(…)`.
      const dot = is(index + 1, ".") ? index + 1 : is(index + 1, "?") && is(index + 2, ".") ? index + 2 : -1;
      if (dot > 0 && at(dot + 1)?.kind === "word" && is(dot + 2, "(")) (called.get(word) ?? called.set(word, new Set()).get(word)!).add(at(dot + 1)!.text);
      continue;
    }
    const frame = top();
    // A key in an object literal, a parameter or property named like the binding, or a declaration of the same name: not a use.
    // (`case FOO:` in a switch is a use.)
    if (is(index + 1, ":") && !inType() && frame.ternary === 0 && (frame.open === "{" || frame.open === "(") && before?.text !== "case") continue;
    if ((is(index + 1, "?") && is(index + 2, ":")) || declaring.has(before?.text ?? "") || before?.text === "function") continue;
    const member = is(index + 1, ".") && at(index + 2)?.kind === "word" ? at(index + 2)!.text : undefined;
    const after = member ? index + 3 : index + 1;
    let how: How;
    if (inType()) {
      how = "types";
      // `db: Db` or `db: Db | undefined`, not `dbs: Db[]` or `make: () => Db`: only then is a member called on `db` one of `Db`'s.
      if (run?.owner && run.kind === "annotation" && run.start === index - 1 && !is(index + 1, "[") && !is(index + 1, ".")) (typed.get(run.owner) ?? typed.set(run.owner, new Set()).get(run.owner)!).add(word);
    } else if (before?.text === "new") how = "constructs";
    else if (extended) how = "extends";
    else if (is(after, "(") || is(after, "`") || (is(after, "<") && typeArguments(after)) || before?.text === "@") how = "calls";
    else how = "references";
    if (binding.namespace) found.push({ local: word, ...member ? { member } : {}, how });
    else found.push({ local: word, ...member && how === "calls" ? { member } : {}, how });
  }
  return [...found, ...callsThrough(typed, called)];
}

/**
 * Every module specifier a file names with a literal: `import`, `import type`, `export … from`, `import("x")` and
 * `require("x")`, in source order, each with the line its statement starts on. Specifiers built at run time cannot
 * be read statically and are not reported. Each import that binds names carries how the file uses them (`jsx`: the file may hold JSX elements).
 */
export function importsOf(source: string, jsx = false): ImportRef[] {
  const tokens = tokenize(source, jsx);
  const found: ImportRef[] = [];
  const bound: { ref: number; binding: Binding }[] = [];
  const skip = new Set<number>();
  const at = (index: number) => tokens[index];
  const is = (index: number, text: string) => at(index)?.text === text && at(index)?.kind !== "string";
  // The clause between `import`/`export` and `from "x"`: only words and the punctuation of named bindings may appear.
  const clauseEnd = (start: number) => {
    // The clause ends at the first token that cannot be part of it, so this bound only stops a pathological file; generated code lists hundreds of names.
    for (let index = start; index < tokens.length && index < start + 50_000; index++) {
      const token = tokens[index]!;
      if (token.kind === "word" && token.text === "from" && at(index + 1)?.kind === "string") return index;
      // A closing brace ends the clause: `export { a }` with no `from` is a local export, even when the next statement starts on the next line.
      if (token.kind === "punct" && token.text === "}" && !(at(index + 1)?.kind === "word" && at(index + 1)!.text === "from")) return -1;
      const allowed = token.kind === "word" || (token.kind === "punct" && ["{", "}", ",", "*"].includes(token.text));
      if (!allowed) return -1;
    }
    return -1;
  };
  const skipRange = (from: number, to: number) => { for (let index = from; index <= to; index++) skip.add(index); };
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
      for (const binding of bindingsOf(typeOnly ? clause.slice(1) : clause, typeOnly)) bound.push({ ref: found.length, binding });
      found.push({ specifier: at(end + 1)!.text, line: token.line, kind: typeOnly || inlineTypes ? "type" : "import", names: importedNames(typeOnly ? clause.slice(1) : clause, false) });
      skipRange(index, end + 1);
      index = end + 1;
    } else if (token.text === "export") {
      const typeOnly = is(index + 1, "type") && (is(index + 2, "{") || is(index + 2, "*"));
      const start = index + 1 + (typeOnly ? 1 : 0);
      if (!is(start, "{") && !is(start, "*")) continue;
      const end = clauseEnd(start);
      if (end < 0) continue;
      found.push({ specifier: at(end + 1)!.text, line: token.line, kind: typeOnly ? "type" : "reexport", names: importedNames(tokens.slice(start, end), true), reexport: true });
      skipRange(index, end + 1);
      index = end + 1;
    } else if (token.text === "require" && is(index + 1, "(") && at(index + 2)?.kind === "string" && is(index + 3, ")")) {
      // `const x = require("y")`, `import x = require("y")`, `const { a, b: c } = require("y")`: what the file calls it.
      if (is(index - 1, "=") && at(index - 2)?.kind === "word" && ["const", "let", "var", "import"].includes(at(index - 3)?.text ?? "")) {
        bound.push({ ref: found.length, binding: { local: at(index - 2)!.text, imported: "*", namespace: true, typeOnly: false } });
        skip.add(index - 2);
      } else if (is(index - 1, "=") && is(index - 2, "}")) {
        let open = index - 3;
        while (open > 0 && !is(open, "{") && index - open < 400) open--;
        if (is(open, "{") && declaring.has(at(open - 1)?.text ?? "")) {
          const parts: Token[][] = [[]];
          for (let item = open + 1; item < index - 2; item++) { skip.add(item); if (is(item, ",")) parts.push([]); else parts.at(-1)!.push(tokens[item]!); }
          for (const words of parts) if (words[0]?.kind === "word") bound.push({ ref: found.length, binding: { local: words[1]?.text === ":" && words[2] ? words[2].text : words[0].text, imported: words[0].text, namespace: false, typeOnly: false } });
        }
      }
      found.push({ specifier: at(index + 2)!.text, line: token.line, kind: "require" });
    }
  }
  if (!bound.length) return found;
  const bindings = new Map(bound.map(item => [item.binding.local, item.binding] as const));
  const occurrences = occurrencesOf(tokens, bindings, skip, jsx);
  return found.map((ref, index) => {
    const own = bound.filter(item => item.ref === index);
    return own.length ? { ...ref, uses: strongestAll(own.map(item => usesOf(item.binding, occurrences))) } : ref;
  });
}

const strongestAll = (lists: readonly Use[][]) => strongest(lists.flat());

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
