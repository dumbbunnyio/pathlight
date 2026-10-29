import { posix } from "node:path";
import { Effect } from "effect";
import { io, type OperationError } from "../effects";
import type { ExportRef, ImportNames, ImportRef } from "../scan-imports";
import { go } from "./go";
import { python } from "./python";
import { typescript } from "./typescript";

/** The `language` of a scanned file. */
export type LanguageName = "typescript" | "javascript" | "python" | "go";
export type UnresolvedReason = "not-found" | "alias-not-configured" | "package-entry-not-found";

/**
 * Where one import leads: files in the workspace (each with the names it takes from that file, so a name can be followed through re-exports), a package
 * outside the workspace, a reason it did not resolve, or nothing to record (an empty specifier, a namespace package with no file of its own).
 */
export type Resolution =
  | { readonly files: readonly { readonly to: string; readonly names?: ImportNames }[] }
  | { readonly external: string }
  | { readonly unresolved: UnresolvedReason }
  | undefined;

/** What a front end may consult to resolve: every listed path, the scanned files, the top-level names each declares, and a reader for configuration. */
export interface Workspace {
  readonly paths: readonly string[];
  readonly files: ReadonlySet<string>;
  readonly declared: ReadonlyMap<string, ReadonlySet<string>>;
  readonly read: (path: string) => Effect.Effect<string | undefined>;
}

/**
 * One language the scan reads. Everything after it is shared: the scan records what `resolve` returns in the same shape for every language, follows
 * names through re-exports the same way, and the draft, check, brief and viewer read the result without knowing the language.
 */
export interface FrontEnd {
  /** The Scan literal for each extension this front end reads. */
  readonly languages: Readonly<Record<string, LanguageName>>;
  /** Loads what parsing needs (a grammar) once per process; the scan calls it only when the listing holds a file of this language. */
  readonly load: () => Promise<void>;
  /** Every import the file names, in source order. `path` is the file's own, for rules that depend on it (a Python package's `__init__.py`). */
  readonly imports: (source: string, path: string) => ImportRef[];
  /** What the file offers to others, names only, in order, at most `limit`. */
  readonly exports: (source: string, limit?: number) => ExportRef[];
  /** The declaration of a name as it is written (its signature, not its body), for a journey's `@ file#name`. */
  readonly declaration: (source: string, name: string) => string | undefined;
  /** The 1-based line that declaration starts on as the file reads now (a decorator's line is not it), for opening the file where a journey's step is. */
  readonly declarationLine: (source: string, name: string) => number | undefined;
  /** Files with this front end's extension that are not the workspace's own source (Go's `vendor/`): neither read nor resolved to. */
  readonly skips?: (path: string) => boolean;
  /** Reads what resolution needs once per scan (configuration files, module roots), then resolves each import of a file. */
  readonly resolver: (workspace: Workspace) => Effect.Effect<(from: string, ref: ImportRef) => Resolution, OperationError>;
}

export const frontEnds: readonly FrontEnd[] = [typescript, python, go];

const byExtension = new Map(frontEnds.flatMap(frontEnd => Object.keys(frontEnd.languages).map(extension => [extension, frontEnd] as const)));

/** The front end that reads a file, by its extension, or undefined for a file no front end reads. */
export const frontEndFor = (path: string) => byExtension.get(posix.extname(path));
export const languageFor = (path: string) => frontEndFor(path)?.languages[posix.extname(path)];
/** Extensions some front end reads. */
export const scannedExtensions: ReadonlySet<string> = new Set(byExtension.keys());
/** The languages the scan reads, as a sentence says them. */
export const scannedLanguages = "TypeScript, JavaScript, Python and Go";

/**
 * The front end that reads a file's declarations, its grammar loaded. A file no front end reads keeps TypeScript's reading, as it had before there were
 * other languages (a journey may name a `.js` file under any extension).
 */
export const declarationsFor = (path: string) => {
  const frontEnd = frontEndFor(path) ?? typescript;
  return io("Scan.grammar", () => frontEnd.load()).pipe(Effect.as(frontEnd));
};
