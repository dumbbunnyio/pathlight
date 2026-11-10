import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { Effect } from "effect";
import { io } from "./effects";
import { declarationsFor } from "./languages";
import type { Scan } from "./scan";

/**
 * Where the code declares it starts: what the project declares (package.json scripts, `bin`, `main`; pyproject.toml's `[project.scripts]` and
 * `[project.gui-scripts]`; Cargo.toml's binaries) and the programs the code declares (a Go file of `package main` with `func main`, a Python `__main__.py` or `main.py`).
 * `pathlight brief` lists them with the files nothing imports; the draft never hides a box that holds one.
 */
export interface DeclaredStart { file: string; why: string }

/** Test files, tool configuration and migrations (a migration is run by a tool, as a test is) are never where the code starts. */
export const notEntry = /(^|\/)(tests?|__tests__|spec|fixtures?|mocks?|testdata)\/|\.(test|spec|d|config|stories)\.[cm]?[jt]sx?$|(^|\/)(vite|vitest|jest|tsup|rollup|webpack|eslint|oxlint)[.\w-]*\.[cm]?[jt]s$|_test\.go$|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$|(^|\/)(migrations|alembic\/versions)\//;
export const notOurs = /(^|\/)(node_modules|\.venv|venv|site-packages|vendor)\//;
const scriptSkipped = /^(test|check|lint|format|fmt|build|prepare|prepublish|postinstall|typecheck|types|clean)\b/;
export const declaredStartsOf = Effect.fn("Starts.declared")(function* (root: string, scan: Pick<Scan, "files">, paths: readonly string[]) {
  const sources = new Set(scan.files.map(file => file.path));
  const found = new Map<string, DeclaredStart>();
  const add = (file: string, why: string) => { if (sources.has(file) && !found.has(file)) found.set(file, { file, why }); };
  for (const manifest of paths.filter(path => posix.basename(path) === "package.json" && !path.includes("node_modules/"))) {
    const directory = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    const parsed = yield* io("Starts.manifest", () => readFile(join(root, manifest), "utf8")).pipe(Effect.map((text): unknown => { try { return JSON.parse(text); } catch { return undefined; } }), Effect.catch(() => Effect.succeed(undefined as unknown)));
    if (typeof parsed !== "object" || !parsed) continue;
    const record = parsed as Record<string, unknown>;
    const resolveIn = (reference: string) => posix.normalize(posix.join(directory, reference.replace(/^\.\//, "")));
    const scripts = typeof record.scripts === "object" && record.scripts ? Object.entries(record.scripts as Record<string, unknown>) : [];
    for (const [name, command] of scripts) {
      if (typeof command !== "string" || scriptSkipped.test(name)) continue;
      for (const word of command.split(/\s+/)) if (/\.[cm]?[jt]sx?$/.test(word) && !word.startsWith("-")) add(resolveIn(word), `script “${name}”${directory ? ` in ${directory}` : ""}`);
    }
    const bins = typeof record.bin === "string" ? [["bin", record.bin]] : typeof record.bin === "object" && record.bin ? Object.entries(record.bin as Record<string, unknown>) : [];
    for (const [name, target] of bins) if (typeof target === "string") add(resolveIn(target), `bin “${name}”`);
    for (const key of ["main", "module"]) if (typeof record[key] === "string") add(resolveIn(record[key] as string), `package ${key}`);
  }
  // A Python script entry is `module.path:function`: the module's file, beside the pyproject or under its `src/`.
  for (const manifest of paths.filter(path => posix.basename(path) === "pyproject.toml" && !notOurs.test(path))) {
    const directory = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    const parsed = yield* io("Starts.pyproject", () => readFile(join(root, manifest), "utf8")).pipe(Effect.map((text): unknown => { try { return Bun.TOML.parse(text); } catch { return undefined; } }), Effect.catch(() => Effect.succeed(undefined as unknown)));
    const project = typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>).project : undefined;
    if (typeof project !== "object" || !project) continue;
    for (const table of ["scripts", "gui-scripts"]) {
      const scripts = (project as Record<string, unknown>)[table];
      if (typeof scripts !== "object" || !scripts) continue;
      for (const [name, target] of Object.entries(scripts as Record<string, unknown>)) {
        const module = typeof target === "string" ? target.split(":")[0]!.trim().replaceAll(".", "/") : "";
        if (!module) continue;
        const file = ["", "src/"].flatMap(base => [`${base}${module}.py`, `${base}${module}/__init__.py`]).map(path => posix.join(directory, path)).find(path => sources.has(path));
        if (file) add(file, `script “${name}” in ${posix.join(directory, "pyproject.toml")}`);
      }
    }
  }
  // A Rust package's binaries, as Cargo finds them: each `[[bin]]`, then `src/main.rs` and `src/bin/` unless `autobins = false`.
  for (const manifest of paths.filter(path => posix.basename(path) === "Cargo.toml" && !notOurs.test(path))) {
    const directory = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    const parsed = yield* io("Starts.cargo", () => readFile(join(root, manifest), "utf8")).pipe(Effect.map((text): unknown => { try { return Bun.TOML.parse(text); } catch { return undefined; } }), Effect.catch(() => Effect.succeed(undefined as unknown)));
    const record = typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : {};
    const table = typeof record.package === "object" && record.package ? record.package as Record<string, unknown> : undefined;
    if (!table || typeof table.name !== "string") continue;
    const at = (path: string) => posix.join(directory, path);
    for (const entry of Array.isArray(record.bin) ? record.bin as unknown[] : []) {
      const bin = typeof entry === "object" && entry ? entry as Record<string, unknown> : {};
      const name = typeof bin.name === "string" ? bin.name : undefined;
      const file = typeof bin.path === "string" ? at(bin.path) : name ? [at(`src/bin/${name}.rs`), at(`src/bin/${name}/main.rs`), at("src/main.rs")].find(path => sources.has(path)) : undefined;
      if (file) add(file, `bin “${name ?? table.name}” in ${manifest}`);
    }
    if (table.autobins === false) continue;
    add(at("src/main.rs"), `Rust binary “${table.name}”`);
    for (const path of [...sources].filter(path => path.startsWith(at("src/bin/")))) {
      const name = /^([^/]+)\.rs$/.exec(path.slice(at("src/bin/").length))?.[1] ?? /^([^/]+)\/main\.rs$/.exec(path.slice(at("src/bin/").length))?.[1];
      if (name) add(path, `Rust binary “${name}”`);
    }
  }
  // Programs the code declares: a Go `package main` holding `func main`, a Python `__main__.py` or `main.py`.
  for (const file of scan.files) {
    if (notEntry.test(file.path) || notOurs.test(file.path)) continue;
    const name = posix.basename(file.path);
    if (name === "__main__.py") add(file.path, "Python __main__ module");
    else if (name === "main.py") add(file.path, "Python main.py");
    else if (file.path.endsWith(".go")) {
      const source = yield* io("Starts.go", () => readFile(join(root, file.path), "utf8")).pipe(Effect.catch(() => Effect.succeed("")));
      if (!/^package\s+main\b/m.test(source)) continue;
      const reader = yield* declarationsFor(file.path);
      if (reader.declaration(source, "main")?.startsWith("func main(")) add(file.path, "Go package main with func main");
    }
  }
  return [...found.values()];
});
