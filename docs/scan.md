# Scan format

`pathlight scan [--workspace PATH] [--out FILE]` reads a workspace's TypeScript, JavaScript, Python, Go and Rust source and writes one JSON document. It exists so that an agent drafting a LikeC4 model does not have to read the whole codebase, and so the same facts can feed several views. It does not write or change a model.

Everything in it is a **static** reading of source text (`"basis": "static"`). It says what the code names, not what runs: a dynamic `import(name)`, a bundler alias or a framework convention is invisible to it, and an import is not proof of a call.

## What it contains

| Field | Meaning |
| --- | --- |
| `root` | The workspace directory's name (no absolute paths, no dates: scanning the same tree twice gives the same text). |
| `files` | Every scanned file: `path`, `language` (`typescript`, `javascript`, `python`, `go`, `rust`), `lines`, and the names it `exports` (at most 80). |
| `imports` | Imports that resolve to a file in the workspace: `from`, `to`, the `line` where the statement starts, its `kind`, the original `specifier`, and `uses`: how `from` uses each name it takes from `to` (below). |
| `external` | Packages outside the workspace (and `node:`/`bun:` built-ins), once per importing file. |
| `unresolved` | Imports that look like they point into the workspace but did not resolve, each with a `reason`: `not-found`, `alias-not-configured` or `package-entry-not-found`. Workspace-package imports follow the target package's `exports` map the same way, including `*` patterns (an explicit entry wins over a pattern). `#name` imports are Node subpath imports: the scan follows the nearest `package.json` `imports` field (resolved with [resolve.exports](https://github.com/lukeed/resolve.exports)) to every runtime variant it names (`bun`, `node`, `workerd`, `default`...), since a static scan cannot know which runtime applies; one that maps to nothing is `alias-not-configured`. |
| `coverage` | How the files were listed (`git` or `walk`), counts, how many files were `skipped`, and `unscanned` languages that are present but not read. |

`kind` is `import`, `type` (an `import type`, `export type … from`, or an import whose every binding is `type`; in Python, an import under `if TYPE_CHECKING:`), `reexport`, `dynamic` (`import("x")` with a literal; in Python, `importlib.import_module("a.b")` or `__import__("a.b")`) or `require`.

## Uses

Each import record lists how the importing file uses what it takes from the target, read from the syntax alone, the strongest use of each name first, at most 12: `[{ "name": "createDocument", "how": "calls" }, { "name": "User", "how": "types" }]`. A module imported whole (`import * as api`, Python `import app.mail`, a Go package) lists the members used through it (`api.createDocument(…)` is `createDocument`).

| `how` | Meaning |
| --- | --- |
| `calls` | `f(…)`, `X.method(…)`, a Go `pkg.Func(…)`, a Rust `path::f(…)` or `Type::method(…)`, a macro, a decorator. A member called through a parameter, field or variable annotated with the imported type (`(db: Db) => db.query()`, Go `func f(s *store.Store) { s.Get() }`, Rust `fn f(c: &Client) { c.send() }`) is a call of that type (`Db.query`), since the file runs that type's code. Methods every value has (`clone`, `toString`, `iter`, `map` …) do not count, and neither does an annotation that is a collection of the type (`Db[]`, `[]*Store`, `Vec<Client>`). |
| `renders` | A JSX element (`<Button />`). |
| `constructs` | `new X(…)`, a Go composite literal `pkg.T{…}`, a Rust struct literal. |
| `extends` | A class's base, Python `class A(Base)`, an embedded Go struct, a Rust `impl Trait for`. |
| `references` | Used as a value any other way: passed, stored, compared, spread, exported again. A position the reading cannot place counts here, so a doubt keeps an arrow. |
| `types` | Only in type positions: annotations, signatures, generic arguments, `implements`, `type` and `interface` bodies, `as`. |

An import **carries code** unless every use it lists is `types` (or, with no uses read, it is written as a type import). An import with no uses read (a side-effect import, `require`, a dynamic import, a name never used) carries code: nothing says it does not. The draft draws an arrow only where an import carries code (`docs/eval.md`, "Uses"); `check` does not ask for one that only shares types; a journey step that names a function is checked against these uses.

What is not seen: a member called on a value whose type the file never writes (an inferred type), a type named only in a string annotation (Python `"Repo"`), and calls through a field reached by more than one dot. TypeScript is read from the tokenizer (template expressions and JSX tag names included; JSX text and attribute names are not code), Python, Go and Rust from their syntax trees. The reading is measured against TypeScript's own compiler and Go's type checker (`tests/eval/facts-uses.ts`).

## Languages

Each language is read by a front end in `src/languages/` that gives the rest of the scan the same records, so the draft, `check`, `diff`, `brief`, flows and the viewer read every language alike. TypeScript and JavaScript are read by the hand-written tokenizer in `src/scan-imports.ts`; Python, Go and Rust by tree-sitter grammars compiled into the binary (nothing is downloaded, and a grammar is loaded only when the workspace has a file in its language).

| Language | Statements read | Resolved by | Not followed (listed, never guessed) |
| --- | --- | --- | --- |
| TypeScript, JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | `import`, `export … from`, `import()` and `require()` with a literal | Relative paths, the nearest tsconfig `baseUrl`/`paths`, workspace packages through `exports`/`main`, `#` subpath imports; a name is followed through barrels (below) | `extends` chains, bundler and framework aliases |
| Python (`.py`) | `import a.b`, `from a.b import c`, relative `from . import x` / `from ..a import y`, `from a import *`, anywhere in a file; `importlib.import_module`/`__import__` with a literal | Roots: the folder of each `pyproject.toml`, `setup.py` and `setup.cfg`, its `src/`, a folder its `package-dir` (`package_dir`, Poetry's `from`) names, and the workspace root; the nearest root above a file first. `a.b.c` is `a/b/c.py` or `a/b/c/__init__.py`; `from a.b import c` is the module `c` if there is one, else the name `c` in `a/b`. A folder without `__init__.py` is a namespace package. A name taken from a package is followed through its `__init__.py`'s `from .mod import name` (and `*`) to the module that defines it. A first segment that is no package of the workspace is a package from outside | `sys.path` edits (including in `conftest.py`), `PYTHONPATH`, `.pth` files, names built at run time |
| Go (`.go`) | every `import` | The nearest `go.mod` names a file's module; a nested `go.mod` is its own module; `go.work` lists modules; a `replace` to a local path is followed; `vendor/` is not read. An import is recorded against the files of the package that declare the names the importing file uses (`storage.New`, `storage.Entry`); a dot or blank import, or a used name no file declares, reaches every file of the package. Test files are read as sources and never targets. The standard library and other modules are packages from outside | Build constraints (`//go:build`, `_linux.go`): every file is read whatever its tags; cgo |
| Rust (`.rs`) | every `use` (groups, `as`, globs, `pub use`), `extern crate`, and a path written in code or a type whose first segment is `crate`, `self`, `super`, `::`, a name a `use` brought in, or a crate (`atuin_common::utils::now()`); code under `#[cfg(test)]` is a test and is not read | Each `Cargo.toml` with a `[package]` is a crate, its targets found as Cargo finds them (`src/lib.rs`, `src/main.rs`, `src/bin/`, the build script, `examples/`, `tests/`, `benches/`, and `[lib]`, `[[bin]]` and the rest); dependencies through `workspace = true` and `package = "…"` renames, a path dependency to that crate's library. From each target's root, `mod x;` is `x.rs` or `x/mod.rs` beside a `lib.rs`, `main.rs` or `mod.rs` and under `a/` for `a.rs`; `#[path]` and inline modules are followed. A path resolves module by module; the segment after the last module is the name taken from that module's file, followed through `pub use` (and `pub use …::*`) like a barrel. Edition 2015 `use` paths start at the crate root. `vendor/` is not read. A crate from outside is named with the next segment of its path (`sqlx/sqlite`); `std`, `core` and `alloc` by name. A file no `mod` reaches is read where it sits under `src/` | `mod x;` (where a file sits, not a use of it); any other `cfg` (features, platforms): every module is read; macros called by bare name; methods and fields (they need types); `include!`; paths inside macro arguments |

## What it follows

- Relative imports, including `.js` specifiers that name a `.ts` file, directory indexes, and non-source files such as `.css` and `.json`.
- The nearest `tsconfig.json`/`jsconfig.json` `baseUrl` and `paths` (comments and trailing commas allowed).
- Packages with a `package.json` inside the workspace (monorepo packages), through `exports`, `main`, `module` and `types`; an entry that names built output (`dist/…`) is looked up under `src/…`.
- Re-exports. A package's entry file usually declares nothing and re-exports everything, so an import of it only says which barrel was named. Each name an import takes is followed through `export * from`, `export { a as b } from` and their `type` forms (and nested barrels) to the file that declares it, and the import is recorded against that file, one record per file reached (same `line` and `specifier`). A namespace import (`import * as`), a side-effect import, or a name that cannot be followed stays on the file it named. The barrel's own `export … from` lines are kept as they are.

It does not follow `extends` chains, bundler or framework aliases, or anything built at run time. What that leaves behind is in `unresolved` or `coverage.unscanned`, not guessed.

Files come from `git ls-files` (tracked plus untracked, ignoring what `.gitignore` excludes) or, outside a repository, a walk that skips `.git`, `.cache` and `node_modules`. Symlinks and files over 2 MiB are skipped and counted. A workspace listing more than 50,000 files is refused; scan a subdirectory.

## How it was checked

The import reader is compared in the tests with Bun's own scanner on this repository's value imports (they agree), and it additionally reports type-only imports and line numbers, which Bun's does not. Run against three real repositories, it found every relative import that an independent regular-expression scan found.

Uses are compared with the compilers' own answers (`tests/eval/facts-uses.ts`): for TypeScript, which import bindings `tsc` removes when it emits JavaScript (a binding no value position uses), and for Go, `go/types` on whether each use of a package sits in a type position; see [eval](eval.md#uses-2026-11-10). Python and Go are compared with each language's own tools: CPython's `ast` and `importlib.machinery.PathFinder` for Python (`tests/eval/facts-python.ts`), `go list` for Go at the package level (`tests/eval/facts-go.ts`); see [eval](eval.md#languages-2026-10-28). Rust is compared with `cargo metadata` at the crate level and rust-analyzer's SCIP index at the file level (`tests/eval/facts-rust.ts`); see [eval](eval.md#rust-2026-11-10).

# Check

`pathlight check [--workspace PATH] [--json] [--strict]` compares a workspace's LikeC4 model and `.pathlight/pathlight.activity.json` with a fresh scan. It is the validator for a model an agent drafted from the scan, and it catches drift when the code changes and the model does not. Like the scan, everything in it is static evidence: a finding is something to look at, not a verdict.

An element's files are those its mappings match; for a relationship, the files of everything *inside* an element count too, so a relationship on a group is supported by imports between its children's files.

| Section | Meaning |
| --- | --- |
| `mappings.shared`, `mappings.sharedImports` | The elements `shared` names in `.pathlight/pathlight.activity.json` (anything may import them, so no relationship is expected) and how many imports into them were left out of `undeclared`. |
| `size` | Files per element, largest first. An element with at least 15 files and a quarter or more of all mapped files is `large`, with the folders inside it. A hint that it may be several things, not a verdict. |
| `wide` | Elements with more than 19 cards side by side inside them (the cards their own readable view draws, else their direct children), the most the draft draws in one box. A hint to group them. |
| `views` | `entries` are the written views no `navigateTo` points to. A diagram normally has one, so more than one is reported as `unlinkedViews`. LikeC4's generated Landscape index is not counted. |
| `mappings.ignored` | Source files left out of "unmapped" by the optional `ignore` list in `.pathlight/pathlight.activity.json` (globs for tests, vendored or generated code that is deliberately outside the model). Only `check` reads it; activity mapping is unchanged. |
| `mappings.unmatched` | A mapping whose glob matches no file in the workspace. |
| `mappings.unmappedFiles` | Scanned source files that no mapping claims, so activity on them lights nothing. |
| `relationships` | Each relationship in the model with a `status`: `supported` (an import connects the two elements' files), `unsupported` (none does) or `unverifiable` (an end has no mapped files). |
| `undeclared` | Imports between two mapped elements that no relationship declares, at that level or above, in either direction. |

A relationship describes flow or use, while an import points from the user to what it uses, so either direction supports a relationship; `direction` says whether the imports run `same` as the relationship, `opposite`, or `both`. `unsupported` does not mean the relationship is wrong: it may run through a network call, an event, a file or configuration, none of which an import shows. An unknown element in a mapping is an error, not a finding. `--strict` makes any finding (an unmatched glob, an unmapped file, an unsupported relationship, an undeclared import) exit 1; unverifiable relationships do not.

