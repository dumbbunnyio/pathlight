#!/usr/bin/env bun
// bun tests/eval/facts-rust.ts --workspace DIR [--out FILE]
//
// Compares the Rust half of `pathlight scan` with two references made by Rust's own tools, written without reading src/languages/rust.ts:
//
// - Crates: `cargo metadata --no-deps`, each workspace package's declared path dependencies (normal, build and dev). The scan's file-to-file records
//   are collapsed to the packages that hold their files. A declared crate the code never names is listed, not counted as a miss; a crate pair the scan
//   has and the manifests do not declare cannot compile, so it is a scan bug.
// - Files: `rust-analyzer scip`, rust-analyzer's own name resolution (macro expansion, cfg) written as a SCIP index. A reference pair is (A, B) when
//   file A uses a symbol defined in file B: named items only (functions, types, traits, consts, statics, macros), not members (methods, fields,
//   variants: they need types or sit beside their type) and not modules (a module's definition is the `mod` line in its parent). rust-analyzer is run
//   with every feature on and `cfg(test)` off for the workspace's crates, as the scan reads every feature and leaves `#[cfg(test)]` code out; files of
//   test and bench targets (`tests/`, `benches/`) are left out on both sides. Expected kinds of disagreement: paths inside macro arguments, names
//   reached by macro expansion, globs the scan cannot narrow, platform `cfg`.
//
// Nothing is written into the workspace: cargo's and rust-analyzer's build output goes to a CARGO_TARGET_DIR under $XDG_CACHE_HOME/pathlight (kept,
// so a second run does not rebuild the build scripts), offline.
// rust-analyzer runs `cargo metadata` in the workspace, which writes a `Cargo.lock` when the workspace has none or a stale one; check
// `git status` of the workspace after a run (both reference repositories commit theirs). Needs `cargo`; the
// file level needs `rust-analyzer` (rustup component add rust-analyzer rust-src) and the dependencies fetched (`cargo fetch`), and is skipped without it.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { scanWorkspace } from "../../src/scan";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, out: { type: "string" } } });
const root = resolve(values.workspace!);
const cargo = Bun.which("cargo");
if (!cargo) { process.stdout.write("cargo is not installed: skipped\n"); process.exit(0); }
const scratch = mkdtempSync(join(tmpdir(), "pathlight-facts-rust-"));
// A repository's rust-toolchain.toml would otherwise make rustup download the toolchain it pins.
const targetDirectory = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pathlight", "facts-rust", createHash("sha256").update(root).digest("hex").slice(0, 16));
const env = { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "stable", CARGO_TARGET_DIR: targetDirectory, CARGO_NET_OFFLINE: "true" };
const testTarget = (path: string) => /(^|\/)(tests|benches)\//.test(path);
const vendored = (path: string) => /(^|\/)vendor\//.test(path);

try {
  const scan = await Effect.runPromise(scanWorkspace(root));
  const rustFiles = scan.files.filter(file => file.language === "rust");

  // Crates.
  interface Package { name: string; manifest_path: string; dependencies: { name: string; path?: string; kind: string | null }[] }
  const metadata = Bun.spawnSync([cargo, "metadata", "--format-version", "1", "--no-deps", "--offline"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  if (metadata.exitCode !== 0) throw new Error(`cargo metadata failed: ${metadata.stderr.toString().trim()}`);
  const packages = (JSON.parse(metadata.stdout.toString()) as { packages: Package[] }).packages;
  const folderOf = (manifest: string) => { const rel = relative(root, posix.dirname(manifest)); return rel === "" ? "." : rel; };
  const folders = packages.map(item => ({ name: item.name, folder: folderOf(item.manifest_path) })).sort((a, b) => b.folder.length - a.folder.length);
  const byFolder = new Map(folders.map(item => [item.folder, item.name] as const));
  const crateOf = (path: string) => folders.find(item => item.folder === "." || path.startsWith(`${item.folder}/`))?.name;
  const declared = new Map<string, string>();
  for (const item of packages) for (const dependency of item.dependencies) {
    if (!dependency.path) continue;
    const target = byFolder.get(relative(root, dependency.path) || ".");
    if (target && target !== item.name) declared.set(`${item.name}\t${target}`, dependency.kind ?? "normal");
  }
  const crates = new Map<string, string>();
  for (const item of scan.imports) {
    if (!item.from.endsWith(".rs") || !item.to.endsWith(".rs")) continue;
    const from = crateOf(item.from), to = crateOf(item.to);
    if (from && to && from !== to && !crates.has(`${from}\t${to}`)) crates.set(`${from}\t${to}`, `${item.from}:${item.line} ${item.specifier}`);
  }
  const crateBoth = [...crates.keys()].filter(pair => declared.has(pair));
  const crateOnlyScan = [...crates.keys()].filter(pair => !declared.has(pair)).sort();
  const crateUnused = [...declared.keys()].filter(pair => !crates.has(pair)).sort();
  process.stdout.write(`crates ${packages.length}; rust files the scan read ${rustFiles.length}\n`
    + `crate pairs: scan ${crates.size}, declared ${declared.size}, both ${crateBoth.length}\n`
    + `scan pairs no manifest declares (scan bugs): ${crateOnlyScan.length}\n${crateOnlyScan.map(pair => `  ${pair.replace("\t", " -> ")}  [${crates.get(pair)}]`).join("\n")}${crateOnlyScan.length ? "\n" : ""}`
    + `declared and never named by the code the scan reads: ${crateUnused.length}${crateUnused.length ? `\n${crateUnused.map(pair => `  ${pair.replace("\t", " -> ")} (${declared.get(pair)})`).join("\n")}` : ""}\n`);

  // Files.
  const analyzer = Bun.which("rust-analyzer");
  let files: Record<string, unknown> = { skipped: "rust-analyzer is not installed" };
  if (!analyzer || Bun.spawnSync([analyzer, "--version"], { env, stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    process.stdout.write("rust-analyzer is not installed: the file level is skipped\n");
  } else {
    const config = join(scratch, "config.json"), output = join(scratch, "index.scip");
    writeFileSync(config, JSON.stringify({ cargo: { features: "all" }, cfg: { setTest: false } }));
    const run = Bun.spawnSync([analyzer, "scip", root, "--output", output, "--config-path", config, "--exclude-vendored-libraries"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`rust-analyzer scip failed: ${run.stderr.toString().trim().slice(-2000)}`);
    const index = decode(new Uint8Array(await Bun.file(output).arrayBuffer()));
    // rust-analyzer names a symbol by package, not by target, so a build script and its library can define the same symbol (bat's
    // `syntax_mapping/MappingTarget#` in build/syntax_mapping.rs and src/syntax_mapping.rs). Such a use is given the definition nearest to it.
    const definedIn = new Map<string, string[]>();
    for (const document of index) for (const occurrence of document.occurrences) if (occurrence.roles & 1) {
      const list = definedIn.get(occurrence.symbol) ?? [];
      if (!list.includes(document.path)) definedIn.set(occurrence.symbol, [...list, document.path]);
    }
    const shared = (a: string, b: string) => { let at = 0; while (at < a.length && a[at] === b[at]) at++; return at; };
    const nearest = (from: string, list: string[]) => [...list].sort((a, b) => shared(from, b) - shared(from, a) || (a < b ? -1 : 1))[0];
    const ambiguous = [...definedIn.values()].filter(list => list.length > 1).length;
    const reference = new Map<string, string>();
    const known = new Set(index.map(document => document.path));
    let inTests = 0;
    for (const document of index) {
      if (testTarget(document.path) || vendored(document.path) || !document.path.endsWith(".rs")) continue;
      const tests = testLines(await Bun.file(join(root, document.path)).text().catch(() => ""));
      for (const occurrence of document.occurrences) {
        if (occurrence.roles & 1 || !item(occurrence.symbol)) continue;
        if (tests.has(occurrence.line)) { inTests++; continue; }
        const list = definedIn.get(occurrence.symbol);
        const to = list && nearest(document.path, list);
        if (!to || to === document.path || testTarget(to) || vendored(to) || !to.endsWith(".rs")) continue;
        const pair = `${document.path}\t${to}`;
        if (!reference.has(pair)) reference.set(pair, `${document.path}:${occurrence.line + 1} ${occurrence.symbol.split(" ").slice(4).join(" ")}`);
      }
    }
    const ours = new Map<string, string>();
    for (const edge of scan.imports) {
      if (!edge.from.endsWith(".rs") || !edge.to.endsWith(".rs") || edge.from === edge.to) continue;
      const pair = `${edge.from}\t${edge.to}`;
      if (!ours.has(pair)) ours.set(pair, `${edge.from}:${edge.line} ${edge.specifier}`);
    }
    const both = [...ours.keys()].filter(pair => reference.has(pair)).length;
    const onlyOurs = [...ours.keys()].filter(pair => !reference.has(pair)).sort(), onlyReference = [...reference.keys()].filter(pair => !ours.has(pair)).sort();
    const unindexed = rustFiles.filter(file => !known.has(file.path) && !vendored(file.path)).map(file => file.path);
    const percent = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(2)}%` : "n/a";
    process.stdout.write(`files rust-analyzer indexed ${known.size}; read by the scan but not indexed ${unindexed.length}; symbols defined in more than one file ${ambiguous}; uses inside #[cfg(test)] items left out ${inTests}\n`
      + `file pairs: scan ${ours.size}, reference ${reference.size}, both ${both}\n`
      + `scan found ${percent(both, reference.size)} of the reference (${onlyReference.length} missed)\n`
      + `reference confirms ${percent(both, ours.size)} of the scan (${onlyOurs.length} the reference does not have)\n`);
    for (const [label, list, source] of [["only the scan", onlyOurs, ours], ["only the reference", onlyReference, reference]] as const) {
      if (!list.length) continue;
      process.stdout.write(`${label}:\n${list.slice(0, 20).map(pair => `  ${pair.replace("\t", " -> ")}  [${source.get(pair)}]`).join("\n")}${list.length > 20 ? `\n  … and ${list.length - 20} more` : ""}\n`);
    }
    files = { unindexed, onlyOurs: onlyOurs.map(pair => ({ pair, via: ours.get(pair) })), onlyReference: onlyReference.map(pair => ({ pair, via: reference.get(pair) })) };
  }
  if (values.out) writeFileSync(values.out, JSON.stringify({ crates: { onlyScan: crateOnlyScan, unused: crateUnused }, files }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }

/**
 * The 0-based lines of a file's `#[cfg(test)]` items (an inline `mod tests { … }`, a function), found from the text alone: rust-analyzer still indexes
 * an inline module that `cfg` turns off, and the scan leaves it out as a test. Braces are matched outside strings, characters and comments.
 */
function testLines(text: string) {
  const lines = new Set<number>();
  for (const match of text.matchAll(/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)) {
    let at = match.index! + match[0].length, depth = 0, opened = false;
    for (; at < text.length; at++) {
      const char = text[at]!;
      if (char === "/" && text[at + 1] === "/") { at = text.indexOf("\n", at); if (at < 0) break; continue; }
      if (char === "/" && text[at + 1] === "*") { at = text.indexOf("*/", at + 2) + 1; if (at <= 0) break; continue; }
      if (char === '"') { for (at++; at < text.length && text[at] !== '"'; at++) if (text[at] === "\\") at++; continue; }
      if (char === "'" && /^'(\\.|[^\\'])'/.test(text.slice(at, at + 4))) { at = text.indexOf("'", at + 2); continue; }
      if (char === ";" && !opened) break;
      if (char === "{") { depth++; opened = true; }
      if (char === "}" && --depth === 0 && opened) break;
    }
    const first = text.slice(0, match.index!).split("\n").length - 1, last = text.slice(0, at).split("\n").length - 1;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

/**
 * A SCIP symbol names an item when its last descriptor is a type (`Name#`), a macro (`name!`), or a term or function (`name.`, `name().`) whose
 * owner is a module (`a/b/`), not a type: a method, a field or a variant hangs off a type. Locals and modules (`name/`) are not items.
 */
function item(symbol: string) {
  if (symbol.startsWith("local ")) return false;
  const descriptors = symbol.split(" ").slice(4).join(" ");
  if (!descriptors || descriptors.endsWith("/")) return false;
  if (/[^/#.!]+!$/.test(descriptors) || /#$/.test(descriptors) && !/#[^/]*#$/.test(descriptors)) return true;
  // A term or method: its owner is what precedes its own descriptor.
  const owner = descriptors.replace(/(`[^`]*`|[^/#.!`]+)(\([^)]*\))?\.$/, "");
  return owner !== descriptors && (owner === "" || owner.endsWith("/"));
}

/** The documents of a SCIP index (protobuf): each one's path and its occurrences (symbol, roles, first line). Only the fields this tool reads. */
function decode(bytes: Uint8Array) {
  const text = new TextDecoder();
  const reader = (start: number, end: number) => {
    let at = start;
    const varint = () => { let result = 0, shift = 0, byte = 0; do { byte = bytes[at++]!; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80); return result; };
    const fields: { field: number; wire: number; value: number; start: number; end: number }[] = [];
    while (at < end) {
      const tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
      if (wire === 0) fields.push({ field, wire, value: varint(), start: 0, end: 0 });
      else if (wire === 2) { const length = varint(); fields.push({ field, wire, value: 0, start: at, end: at + length }); at += length; }
      else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else throw new Error(`unexpected wire type ${wire}`);
    }
    return fields;
  };
  const documents: { path: string; occurrences: { symbol: string; roles: number; line: number }[] }[] = [];
  for (const top of reader(0, bytes.length)) {
    if (top.field !== 2 || top.wire !== 2) continue;
    const document = { path: "", occurrences: [] as { symbol: string; roles: number; line: number }[] };
    for (const field of reader(top.start, top.end)) {
      if (field.field === 1 && field.wire === 2) document.path = text.decode(bytes.subarray(field.start, field.end));
      else if (field.field === 2 && field.wire === 2) {
        const occurrence = { symbol: "", roles: 0, line: 0 };
        for (const inner of reader(field.start, field.end)) {
          if (inner.field === 2 && inner.wire === 2) occurrence.symbol = text.decode(bytes.subarray(inner.start, inner.end));
          else if (inner.field === 3 && inner.wire === 0) occurrence.roles = inner.value;
          else if (inner.field === 1 && inner.wire === 2 && inner.end > inner.start) occurrence.line = packedFirst(inner.start);
        }
        document.occurrences.push(occurrence);
      }
    }
    documents.push(document);
  }
  return documents;

  /** The first value of a packed varint field: the occurrence's start line. */
  function packedFirst(start: number) { let result = 0, shift = 0, byte = 0, at = start; do { byte = bytes[at++]!; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80); return result; }
}
