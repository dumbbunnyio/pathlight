import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { View } from "./catalog";
import { run } from "./process";
import { Effect } from "effect";
import { io, hasCode, failure } from "./effects";

export const exportView = Effect.fn("Export.png")(function* (view: View) {
  const cache = join(view.workspace, ".cache", "c4view");
  yield* io("Export.mkdir", () => mkdir(cache, { recursive: true }));
  const directory = yield* io("Export.directory", () => mkdtemp(join(cache, "render-")));
  const cli = join(dirname(fileURLToPath(import.meta.resolve("likec4"))), "..", "bin", "likec4.mjs");
  yield* run("node", [cli, "export", "png", view.workspace,
    "--project", view.project, "--filter", view.id, "--flat", "--outdir", directory,
    "--chromium-sandbox", "--max-attempts", "1"]);
  const candidate = join(directory, `${view.id}.png`);
  const image = yield* io("Export.stat", () => stat(candidate)).pipe(Effect.as(candidate),
    Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed(join(directory, view.project, `${view.id}.png`))));
  if ((yield* io("Export.stat", () => stat(image))).size === 0) return yield* Effect.fail(failure("Export.png", "LikeC4 exported an empty image."));
  return { ...view, image, directory };
});
