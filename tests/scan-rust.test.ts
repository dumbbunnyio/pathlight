import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { declarationsFor } from "../src/languages";
import { rust } from "../src/languages/rust";
import { scanWorkspace } from "../src/scan";

const imports = (scan: Awaited<ReturnType<typeof scanFixture>>) => scan.imports.map(item => `${item.from}:${item.line} ${item.specifier} -> ${item.to}`);
async function scanFixture(files: Record<string, string> | string) {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-rust-"));
  try {
    if (typeof files === "string") await cp(files, directory, { recursive: true });
    else for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); }
    return await Effect.runPromise(scanWorkspace(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// The fixture is a workspace of two crates: `mod.rs` and `name.rs` layouts, `#[path]`, an inline module, `crate`/`super`/`self` paths, a group with a
// rename, a glob, a `pub use` barrel two levels deep, a path written in code, `#[cfg(test)]` code, a `cfg(feature)` module, a renamed path dependency
// read from the workspace, binaries declared and found, a build script, an example, an integration test, a vendored crate and a file no `mod` reaches.
test("a Rust workspace: each import reaches the file that declares the name, through the module tree and pub use", async () => {
  const scan = await scanFixture("tests/fixtures/rust");
  expect(scan.files.map(file => `${file.path} ${file.language} ${file.exports!.map(item => `${item.kind}:${item.name}`).join(",")}`)).toEqual([
    "crates/app/build.rs rust ", "crates/app/examples/demo.rs rust ", "crates/app/gen.rs rust function:make", "crates/app/src/admin.rs rust ",
    "crates/app/src/bin/report/main.rs rust ", "crates/app/src/cli.rs rust function:run", "crates/app/src/main.rs rust ", "crates/app/tests/it.rs rust ",
    "crates/core/src/extra.rs rust ", "crates/core/src/lib.rs rust namespace:store,namespace:inline,reexport:Price",
    "crates/core/src/money.rs rust namespace:rates,class:Price", "crates/core/src/money/rates.rs rust class:Rate", "crates/core/src/odd/place.rs rust function:place",
    "crates/core/src/orphan.rs rust ", "crates/core/src/store/cart.rs rust class:Cart,function:total", "crates/core/src/store/mod.rs rust namespace:cart,reexport:Cart",
    // vendor/ is someone else's code: not read.
    "crates/core/src/tests.rs rust ",
  ]);
  expect(imports(scan)).toEqual([
    // A build script is its own crate root: `mod gen;` is the file beside it.
    "crates/app/build.rs:3 gen::make -> crates/app/gen.rs",
    // `shop` is the renamed shop-core; `Price` is offered by lib.rs's `pub use` and declared in money.rs.
    "crates/app/examples/demo.rs:1 shop::Price -> crates/core/src/money.rs",
    "crates/app/src/admin.rs:1 shop::Price -> crates/core/src/money.rs",
    "crates/app/src/bin/report/main.rs:1 shop::Cart -> crates/core/src/store/cart.rs",
    "crates/app/src/main.rs:3 shop::Price -> crates/core/src/money.rs",
    // Two levels of `pub use`: lib.rs's `store::*`, then store/mod.rs's `self::cart::Cart`.
    "crates/app/src/main.rs:3 shop::Cart -> crates/core/src/store/cart.rs",
    "crates/app/src/main.rs:4 shop::store::cart -> crates/core/src/store/cart.rs",
    // A path written in code; `inline` is a module inside lib.rs.
    "crates/app/src/main.rs:7 shop::inline::helper -> crates/core/src/lib.rs",
    "crates/app/src/main.rs:8 cli::run -> crates/app/src/cli.rs",
    // A module under `cfg(feature)` is read: features are not evaluated.
    "crates/core/src/extra.rs:1 crate::money::Price -> crates/core/src/money.rs",
    "crates/core/src/lib.rs:7 money::Price -> crates/core/src/money.rs",
    "crates/core/src/lib.rs:8 store::* -> crates/core/src/store/mod.rs",
    // money.rs is not a mod.rs, so its `mod rates;` is money/rates.rs.
    "crates/core/src/money/rates.rs:1 crate::inline::helper -> crates/core/src/lib.rs",
    "crates/core/src/odd/place.rs:1 crate::money::Price -> crates/core/src/money.rs",
    // A file no `mod` reaches is read where it sits.
    "crates/core/src/orphan.rs:1 crate::money::Price -> crates/core/src/money.rs",
    "crates/core/src/store/cart.rs:6 super::super::money::Price -> crates/core/src/money.rs",
    "crates/core/src/store/cart.rs:7 crate::money::rates::Rate -> crates/core/src/money/rates.rs",
    // `#[path = "odd/place.rs"] mod placed;`
    "crates/core/src/store/cart.rs:14 crate::placed::place -> crates/core/src/odd/place.rs",
    "crates/core/src/store/mod.rs:3 self::cart::Cart -> crates/core/src/store/cart.rs",
    // Not here: cart.rs's `#[cfg(test)] mod tests`, tests.rs (declared under `#[cfg(test)]`) and tests/it.rs.
  ]);
  expect(scan.external.map(item => `${item.from}:${item.line} ${item.package}`)).toEqual([
    // A build script may use build-dependencies; an external crate is named with the next segment of its path, through the manifest's rename.
    "crates/app/build.rs:6 cc/Build", "crates/app/src/cli.rs:1 reqwest/Client", "crates/app/src/cli.rs:2 sqlx/sqlite",
    "crates/core/src/store/cart.rs:4 serde/Deserialize", "crates/core/src/store/cart.rs:4 serde/Serialize", "crates/core/src/store/cart.rs:3 serde_json/Value",
    "crates/core/src/store/cart.rs:1 std",
  ]);
  expect(scan.unresolved.map(item => `${item.from}:${item.line} ${item.specifier} ${item.reason}`)).toEqual(["crates/core/src/orphan.rs:2 super::super::gone::Thing not-found"]);
  expect(scan.coverage.unscanned).toEqual([]);
});

test("a name a use brought in starts a path, an extern crate alias names its crate, and edition 2015 paths start at the crate root", async () => {
  const scan = await scanFixture({
    "Cargo.toml": '[package]\nname = "old"\nversion = "0.1.0"\n\n[dependencies]\nregex = "1"\n',
    "src/lib.rs": "extern crate regex as re;\n\nmod a;\nmod b;\n",
    "src/a.rs": "pub mod deep;\npub fn top() {}\n",
    "src/a/deep.rs": "pub fn f() {}\n",
    // 2015: `use a::deep` is crate-relative; `deep::f()` goes through the name the use brought in; `re::Regex` is the aliased crate; `::regex` is global.
    "src/b.rs": "use a::deep;\nuse a;\n\nfn g() {\n    deep::f();\n    a::top();\n    re::Regex::new(\"x\");\n    ::regex::escape(\"x\");\n}\n",
  });
  expect(imports(scan)).toEqual(["src/b.rs:1 a::deep -> src/a/deep.rs", "src/b.rs:2 a -> src/a.rs", "src/b.rs:5 deep::f -> src/a/deep.rs", "src/b.rs:6 a::top -> src/a.rs"]);
  expect(scan.external.map(item => `${item.from}:${item.line} ${item.package}`)).toEqual(["src/b.rs:7 regex/Regex", "src/b.rs:8 regex/escape", "src/lib.rs:1 regex"]);
});

test("a use cycle through cfg alternatives ends, and a #[path] file's own mod is the file beside it", async () => {
  // Edition 2015 (no `edition`): each file takes X from the other under one platform and declares it under the other.
  const cycle = await scanFixture({
    "Cargo.toml": '[package]\nname = "n"\nversion = "0.1.0"\n',
    "src/lib.rs": "mod a;\nmod b;\nmod c;\n",
    "src/a.rs": "#[cfg(unix)]\nuse b::X;\n#[cfg(windows)]\npub struct X;\n",
    "src/b.rs": "#[cfg(windows)]\nuse a::X;\n#[cfg(unix)]\npub struct X;\n",
    "src/c.rs": "use a::X;\nuse ::b::X as Y;\n",
  });
  expect(imports(cycle).filter(line => line.startsWith("src/c.rs"))).toEqual(["src/c.rs:1 a::X -> src/a.rs", "src/c.rs:1 a::X -> src/b.rs", "src/c.rs:2 ::b::X -> src/a.rs",
    "src/c.rs:2 ::b::X -> src/b.rs"]);
  const placed = await scanFixture({
    "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": '#[path = "odd/place.rs"]\nmod placed;\n\npub fn f() { placed::sub::g(); }\n',
    "src/odd/place.rs": "pub mod sub;\n",
    "src/odd/sub.rs": "pub fn g() {}\n",
    "src/odd/place/sub.rs": "pub fn g() {}\n",
  });
  expect(imports(placed)).toEqual(["src/lib.rs:4 placed::sub::g -> src/odd/sub.rs"]);
});

test("macros, macro arguments, globs, platform aliases and re-exported modules are followed to the file that declares the name", async () => {
  const scan = await scanFixture({
    "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": "#[macro_use]\nmod macros;\npub mod error;\npub mod net;\npub mod assets;\npub mod ui;\n",
    "src/macros.rs": "#[macro_export]\nmacro_rules! warn { ($e:expr) => {} }\n",
    "src/error.rs": "pub type Result<T> = std::result::Result<T, ()>;\n",
    // `use unix as platform` and `use windows as platform`: every `cfg` is read, so both are where `platform` leads.
    "src/net/mod.rs": "#[cfg(unix)]\nmod unix;\n#[cfg(windows)]\nmod windows;\n#[cfg(unix)]\nuse unix as platform;\n#[cfg(windows)]\nuse windows as platform;\npub use platform::Address;\n",
    "src/net/unix.rs": "pub struct Address;\n",
    "src/net/windows.rs": "pub struct Address;\n",
    // A child's `use super::*` also takes what its parent brought in privately (`Result` from error.rs).
    "src/assets/mod.rs": "mod lazy;\nuse crate::error::*;\npub use lazy::Lazy;\n",
    "src/assets/lazy.rs": "use super::*;\n\npub struct Lazy;\n\nfn load() -> Result<Lazy> { Ok(Lazy) }\n",
    // `pub use crate::net;` re-exports a module: a path through it goes on to the file that declares the name.
    "src/ui/mod.rs": "pub mod view;\npub use crate::net;\n",
    "src/ui/view.rs": "use crate::ui::net::Address;\nuse crate::assets::*;\n\nfn show(_: Lazy) {\n    crate::warn!(\"x\");\n    println!(\"{}\", crate::error::describe());\n}\n",
  });
  const from = (file: string) => imports(scan).filter(line => line.startsWith(file));
  expect(from("src/assets/lazy.rs")).toEqual(["src/assets/lazy.rs:1 super::* -> src/assets/mod.rs", "src/assets/lazy.rs:1 super::* -> src/error.rs"]);
  expect(from("src/net/mod.rs")).toEqual(["src/net/mod.rs:6 unix -> src/net/unix.rs", "src/net/mod.rs:8 windows -> src/net/windows.rs",
    "src/net/mod.rs:9 platform::Address -> src/net/unix.rs", "src/net/mod.rs:9 platform::Address -> src/net/windows.rs"]);
  expect(from("src/ui/view.rs")).toEqual([
    "src/ui/view.rs:1 crate::ui::net::Address -> src/net/unix.rs", "src/ui/view.rs:1 crate::ui::net::Address -> src/net/windows.rs",
    // The glob takes `Lazy` through assets/mod.rs's `pub use` to lazy.rs.
    "src/ui/view.rs:2 crate::assets::* -> src/assets/lazy.rs", "src/ui/view.rs:2 crate::assets::* -> src/assets/mod.rs",
    // An exported macro is at the crate's root but declared in macros.rs; a path inside a macro's arguments is read.
    "src/ui/view.rs:5 crate::warn -> src/macros.rs", "src/ui/view.rs:6 crate::error::describe -> src/error.rs",
  ]);
});

test("a Rust declaration is its signature, attributes and doc comments left out, methods in impl blocks included", async () => {
  const source = "/// Docs.\n#[derive(Debug)]\npub struct Store {\n    items: Vec<u8>,\n}\n\nimpl Store {\n    pub async fn sync(\n        &self,\n        force: bool,\n    ) -> Result<()> {\n        Ok(())\n    }\n}\n\npub trait Saver { fn save(&self); }\n\nmacro_rules! log { () => {} }\n\npub const LIMIT: usize = 3;\n";
  expect(rust.declaration(source, "Store")).toBe("pub struct Store");
  expect(rust.declaration(source, "sync")).toBe("pub async fn sync( &self, force: bool, ) -> Result<()>");
  expect(rust.declaration(source, "Saver")).toBe("pub trait Saver");
  expect(rust.declaration(source, "save")).toBe("fn save(&self);");
  expect(rust.declaration(source, "log")).toBe("macro_rules! log");
  expect(rust.declaration(source, "LIMIT")).toBe("pub const LIMIT: usize = 3;");
  expect(rust.declaration(source, "missing")).toBeUndefined();
  const frontEnd = await Effect.runPromise(declarationsFor("src/store.rs"));
  expect([frontEnd.declarationLine(source, "Store"), frontEnd.declarationLine(source, "sync"), frontEnd.declarationLine(source, "missing")]).toEqual([3, 8, undefined]);
});
