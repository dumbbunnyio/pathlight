import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { go } from "../src/languages/go";
import { scanWorkspace } from "../src/scan";

// The fixture is one module with nested packages, an internal package, a dot import, a blank import, a test file, a package of three files of which
// two declare what is used and one does not, a package whose name is not its folder's, the standard library, another module and a missing package.
test("a Go workspace: an import reaches the files of the package that declare the names the importing file uses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-go-"));
  try {
    await cp("tests/fixtures/go", directory, { recursive: true });
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.files.map(file => `${file.path} ${file.language} ${file.exports!.map(item => `${item.kind}:${item.name}`).join(",")}`)).toEqual([
      "cmd/shop/extra.go go ", "cmd/shop/main.go go ", "internal/format/format.go go function:Price", "internal/format/nested/deep.go go ",
      "internal/render/page.go go class:Page", "internal/storage/doc.go go ", "internal/storage/entry.go go class:Entry,const:MaxEntries",
      // A method (`func (s *Store) Add`) is not listed: no other package names it through the package.
      "internal/storage/storage.go go class:Store,function:New", "internal/storage/storage_test.go go function:TestNew",
    ]);
    expect(scan.imports.map(item => `${item.from}:${item.line} ${item.specifier.replace("example.com/shop/", "")} -> ${item.to}`)).toEqual([
      // `storage.Ghost` is declared by no file, so the import keeps the whole package.
      "cmd/shop/extra.go:5 internal/storage -> internal/storage/doc.go",
      "cmd/shop/extra.go:5 internal/storage -> internal/storage/entry.go",
      "cmd/shop/extra.go:5 internal/storage -> internal/storage/storage.go",
      // A dot import and a blank import reach every file of their package.
      "cmd/shop/main.go:7 internal/format -> internal/format/format.go",
      "cmd/shop/main.go:8 internal/format/nested -> internal/format/nested/deep.go",
      // `view.Page`: the package's name comes from its files' `package` clause, not its folder.
      "cmd/shop/main.go:9 internal/render -> internal/render/page.go",
      // `st.Entry` and `st.New` through the alias: the two files that declare them, not doc.go.
      "cmd/shop/main.go:10 internal/storage -> internal/storage/entry.go",
      "cmd/shop/main.go:10 internal/storage -> internal/storage/storage.go",
      // A test file is read as a source and is never a target.
      "internal/storage/storage_test.go:6 internal/format -> internal/format/format.go",
    ]);
    expect(scan.external.map(item => `${item.from}:${item.line} ${item.package}`)).toEqual([
      "cmd/shop/main.go:6 example.com/other/lib", "cmd/shop/main.go:4 fmt", "internal/storage/storage_test.go:4 testing",
    ]);
    expect(scan.unresolved.map(item => `${item.from}:${item.line} ${item.specifier} ${item.reason}`)).toEqual(["cmd/shop/extra.go:4 example.com/shop/internal/missing not-found"]);
    expect(scan.coverage.unscanned).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("go.work modules, a local replace and a nested module each resolve to their own folders, and vendor/ is not read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-go-work-"));
  const files: Record<string, string> = {
    "go.work": "go 1.26\n\nuse (\n\t./api\n\t./web\n)\n",
    "api/go.mod": "module example.com/api\n",
    "api/types/types.go": "package types\n\ntype User struct{}\n",
    "web/go.mod": "module example.com/web\n\nrequire example.com/util v0.0.0\n\nreplace example.com/util => ../util\n",
    "web/main.go": 'package main\n\nimport (\n\t"example.com/api/types"\n\t"example.com/util/text"\n\t"example.com/web/plugins/x"\n\t"github.com/vendored/dep"\n)\n\nvar _ = types.User{}\nvar _ = text.Upper\nvar _ = x.Y\nvar _ = dep.Z\n',
    "web/plugins/go.mod": "module example.com/web/plugins\n",
    "web/plugins/x/x.go": "package x\n\nvar Y = 1\n",
    "web/vendor/github.com/vendored/dep/dep.go": "package dep\n\nvar Z = 1\n",
    "util/go.mod": "module example.com/util\n",
    "util/text/text.go": "package text\n\nfunc Upper() {}\n",
  };
  try {
    for (const [path, text] of Object.entries(files)) await Bun.write(join(directory, path), text);
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.files.map(file => file.path)).not.toContain("web/vendor/github.com/vendored/dep/dep.go");
    expect(scan.imports.map(item => `${item.specifier} -> ${item.to}`)).toEqual(["example.com/api/types -> api/types/types.go", "example.com/util/text -> util/text/text.go"]);
    // web/plugins is a module of its own, so example.com/web/plugins/x is not a folder of example.com/web.
    expect(scan.unresolved.map(item => item.specifier)).toEqual(["example.com/web/plugins/x"]);
    expect(scan.external.map(item => item.package)).toEqual(["github.com/vendored/dep"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a Go declaration is its signature: a function, a method, a struct or interface by its keyword, anything else whole", async () => {
  await go.load();
  const source = "package p\n\n// New makes one.\nfunc New(a int,\n\tb string) (*Store, error) {\n\treturn nil, nil\n}\n\nfunc (s *Store) Add(e Entry) error { return nil }\n\ntype Store struct {\n\tentries []Entry\n}\n\ntype Box[K comparable] interface{ Get() K }\n\ntype ID = string\n";
  expect(go.declaration(source, "New")).toBe("func New(a int, b string) (*Store, error)");
  expect(go.declaration(source, "Add")).toBe("func (s *Store) Add(e Entry) error");
  expect(go.declaration(source, "Store")).toBe("type Store struct");
  expect(go.declaration(source, "Box")).toBe("type Box[K comparable] interface");
  expect(go.declaration(source, "ID")).toBe("type ID = string");
  expect(go.declaration(source, "missing")).toBeUndefined();
});
