import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ActivityConfig } from "./activity";
import { Effect } from "effect";
import { io, failure, type OperationError } from "./effects";

export const nodeFiles = Effect.fn("NodeFiles.scan")(function* (workspace: string, config: ActivityConfig | undefined) {
  const files = new Map<string, string[]>();
  if (!config?.mappings.length) return files;
  const rules = config.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) }));
  const excluded = new Set([".git", ".cache", "node_modules"]);
  let visited = 0;
  const walk = (directory: string): Effect.Effect<void, OperationError> => Effect.gen(function* () {
    for (const entry of yield* io("NodeFiles.entries", () => readdir(join(workspace, directory), { withFileTypes: true }))) {
      if (++visited > 50_000) return yield* Effect.fail(failure("NodeFiles.scan", "File scan exceeds 50,000 entries. Use a smaller workspace."));
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (/[\x00-\x1f\x7f]/.test(path)) continue;
      if (entry.isDirectory() && !excluded.has(entry.name)) yield* walk(path);
      if (!entry.isFile()) continue;
      for (const element of new Set(rules.filter(rule => rule.match.match(path)).map(rule => rule.element))) {
        const paths = files.get(element) ?? [];
        paths.push(path);
        files.set(element, paths);
      }
    }
  });
  yield* walk("");
  for (const paths of files.values()) paths.sort();
  return files;
});

export const editorFile = Effect.fn("NodeFiles.editorPath")(function* (workspace: string, path: string) {
  const root = yield* io("NodeFiles.workspace", () => realpath(workspace));
  const file = yield* io("NodeFiles.realpath", () => realpath(resolve(root, path)));
  const within = relative(root, file);
  if (!within || within === ".." || within.startsWith("../") || isAbsolute(within)) {
    return yield* Effect.fail(failure("NodeFiles.editorPath", "File is outside this workspace."));
  }
  if (!(yield* io("NodeFiles.stat", () => stat(file))).isFile()) return yield* Effect.fail(failure("NodeFiles.editorPath", "Path is not a regular file."));
  return file;
});
