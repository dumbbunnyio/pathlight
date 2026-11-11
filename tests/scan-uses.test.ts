import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { python } from "../src/languages/python";
import { rust } from "../src/languages/rust";
import { importsOf } from "../src/scan-imports";
import { scanWorkspace } from "../src/scan";
import { carriesCode, type How } from "../src/uses";

// How each imported name is used, by name: the strongest use the reader found.
const howOf = (uses: readonly { name: string; how: How }[] | undefined) => Object.fromEntries((uses ?? []).map(use => [use.name, use.how]));
const workspace = async (files: Record<string, string>) => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-uses-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  return directory;
};

test("TypeScript: each name is read as called, constructed, extended, referenced or only a type", () => {
  const [x, ns] = importsOf([
    'import { run, Base, Shape, Thing, Options, value, Db, Many, Kind } from "./x";',
    'import * as ns from "./ns";',
    "class Car extends Base implements Shape { db: Db; go(o: Options): Kind { this.db.query(); return new Thing(run(o)); } }",
    "const many: Many[] = []; many.map(item => item);",
    "const keys = { value: 1 }; const kept = { other: value };",
    "ns.helper(); const T = ns.Type;",
  ].join("\n"));
  expect(howOf(x!.uses)).toMatchObject({ run: "calls", Thing: "constructs", Base: "extends", value: "references", "Db.query": "calls",
    Shape: "types", Options: "types", Kind: "types", Many: "types" });
  // An array of a type has the array's methods: `many.map` is not a call of `Many`.
  expect(Object.keys(howOf(x!.uses))).not.toContain("Many.map");
  expect(howOf(ns!.uses)).toEqual({ helper: "calls", Type: "references" });
});

test("TypeScript: a statement whose every name is a type carries no code, unless a member is called through a local it annotates", () => {
  const [typesOnly, called] = importsOf([
    'import { Props, Ref } from "./types";',
    'import type { Client } from "./client";',
    "function view(props: Props, ref: Ref) { return props; }",
    "function send(client: Client) { client.post(); }",
  ].join("\n"));
  expect(carriesCode(typesOnly!)).toBe(false);
  // `import type` says no value is imported, but `client.post()` runs the client's code.
  expect(called!.kind).toBe("type");
  expect(carriesCode(called!)).toBe(true);
});

test("TypeScript: positions that only look like types are values", () => {
  const [x] = importsOf([
    'import { a, b, c, d, e, f } from "./x";',
    // An object's key and a ternary's branches are not annotations; a key named `class` is not a class.
    "const o = { key: a, class: 'x', other: b };",
    "const t = flag ? c : d;",
    // A class head's own object literal (`Schema.Class<T>("id")({ … })`) is not the class body.
    "class E extends Make<E>('id')({ field: e }) {}",
    // A template expression is code.
    "const s = `${f()}`;",
  ].join("\n"));
  expect(howOf(x!.uses)).toMatchObject({ a: "references", b: "references", c: "references", d: "references", e: "references", f: "calls" });
});

test("TypeScript: JSX elements render what they name, and text, attributes and comments inside them are not code", () => {
  const [x] = importsOf([
    'import { Button, List, Item, Label, format } from "./ui";',
    "export const View = () => (",
    "  <List<Item>",
    "    // the user's choice: an apostrophe in a comment between attributes",
    '    type="plain"',
    "    render={() => <Button />}",
    "  >",
    "    Don't read: Label is text here",
    "    {format(1)}",
    "  </List>",
    ");",
    "type Picker = <T>(value: T) => T;",
    "export const after = (l: Label) => format(2);",
  ].join("\n"), true);
  expect(howOf(x!.uses)).toMatchObject({ Button: "renders", List: "renders", format: "calls", Label: "types" });
});

test("Python: calls, base classes, annotations and calls through an annotated parameter", async () => {
  await python.load();
  const [db, mail] = python.imports([
    "from app.db import Db, connect, Base, Model",
    "import app.mail",
    "class Repo(Base):",
    "    def run(self, db: Db) -> Model:",
    "        db.query()",
    "        app.mail.send()",
    "        return connect()",
  ].join("\n"), "repo.py");
  expect(howOf(db!.uses)).toEqual({ "Db.query": "calls", connect: "calls", Base: "extends", Db: "types", Model: "types" });
  expect(howOf(mail!.uses)).toEqual({ send: "calls" });
});

test("Rust: calls, struct literals, implemented traits, types and calls through an annotated parameter", async () => {
  await rust.load();
  const refs = rust.imports([
    "use crate::net::{Client, Config, Handler, Message, send};",
    "struct Server;",
    "impl Handler for Server {}",
    "fn go(client: &Client, message: Message) {",
    "    let config = Config { port: 1 };",
    "    client.post();",
    "    send(message);",
    "}",
  ].join("\n"), "src/lib.rs").filter(ref => ref.uses);
  const uses = Object.assign({}, ...refs.map(ref => howOf(ref.uses)));
  expect(uses).toMatchObject({ send: "calls", Config: "constructs", Handler: "extends", Message: "types", Client: "types", "Client::post": "calls" });
  // An enum whose variants a `use` brings in is used as a value, even when the code names it otherwise only as a type.
  const [mode] = rust.imports("use crate::paging::Mode;\nfn run(mode: Mode) { use self::Mode::*; match mode { Always => {}, _ => {} } }", "src/lib.rs").filter(ref => ref.uses);
  expect(howOf(mode!.uses)).toMatchObject({ Mode: "references" });
});

test("Go: calls, composite literals, embedded structs, types and calls through an annotated parameter, each on the file that declares it", async () => {
  const directory = await workspace({
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "store/store.go": "package store\n\ntype Store struct{}\n\nfunc (s *Store) Get() {}\n\nfunc Open() *Store { return nil }\n",
    "store/entry.go": "package store\n\ntype Entry struct{ ID int }\n\ntype Base struct{}\n\ntype Kind int\n",
    "app/app.go": [
      "package app", "", 'import "example.com/app/store"', "",
      "type Handler struct {", "\tstore.Base", "\tkind store.Kind", "}", "",
      "func Run(s *store.Store) {", "\ts.Get()", "\t_ = store.Open()", "\t_ = store.Entry{ID: 1}", "}",
    ].join("\n"),
  });
  try {
    const scan = await Effect.runPromise(scanWorkspace(directory));
    const to = (file: string) => howOf(scan.imports.find(item => item.from === "app/app.go" && item.to === file)?.uses);
    expect(to("store/store.go")).toEqual({ Open: "calls", "Store.Get": "calls", Store: "types" });
    expect(to("store/entry.go")).toEqual({ Entry: "constructs", Base: "extends", Kind: "types" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the scan sends each use through a barrel to the file that declares it, and leaves a types-only file without code", async () => {
  const directory = await workspace({
    "package.json": '{ "name": "app" }',
    "lib/index.ts": 'export * from "./run";\nexport * from "./types";\n',
    "lib/run.ts": "export function run() {}\n",
    "lib/types.ts": "export interface Options { size: number }\n",
    "main.ts": 'import { run, Options } from "./lib";\nexport const go = (options: Options) => run();\n',
  });
  try {
    const scan = await Effect.runPromise(scanWorkspace(directory));
    const from = scan.imports.filter(item => item.from === "main.ts");
    expect(Object.fromEntries(from.map(item => [item.to, howOf(item.uses)]))).toEqual({ "lib/run.ts": { run: "calls" }, "lib/types.ts": { Options: "types" } });
    expect(Object.fromEntries(from.map(item => [item.to, carriesCode(item)]))).toEqual({ "lib/run.ts": true, "lib/types.ts": false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("values in less obvious places: a case label, a keyword argument, a comparison, and a fallback after `as`", async () => {
  const [x] = importsOf([
    'import { FOO, LIMIT, Name, DEFAULT, Action, Kind } from "./x";',
    "function reduce(state: number, action: Action) { switch (action.type) { case FOO: return 1 } }",
    "if (count < LIMIT && total > (count + 1)) {}",
    "const pick = a < b ? Name : c > (d);",
    "const port = process.env.PORT as string || DEFAULT;",
    "type ByKind = { [Kind.Aws]: string; other: Kind };",
  ].join("\n"));
  expect(howOf(x!.uses)).toMatchObject({ FOO: "references", LIMIT: "references", Name: "references", DEFAULT: "references", Action: "types", Kind: "references" });
  await python.load();
  const [schemas] = python.imports("from .schemas import UserOut, UserIn\ndef create(data: UserIn):\n    return serialize(model=UserOut)\n", "routes.py");
  expect(howOf(schemas!.uses)).toMatchObject({ UserOut: "references", UserIn: "types" });
  expect(carriesCode(schemas!)).toBe(true);
});

test("Rust: a member called on a trait object or an `impl Trait` parameter is a call of that trait", async () => {
  await rust.load();
  for (const parameter of ["&dyn Shout", "impl Shout", "&(dyn Shout + Send)", "Arc<dyn Shout>"]) {
    const [shout] = rust.imports(`use crate::ext::Shout;\nfn f(t: ${parameter}) { t.shout() }`, "src/lib.rs").filter(ref => ref.uses?.length);
    expect(howOf(shout!.uses)["Shout::shout"]).toBe("calls");
  }
});
