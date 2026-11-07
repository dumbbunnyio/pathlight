// Writes the scene `pathlight web` would send (dark palette) for a workspace, as the page's Rust tests read it: web/tests/*.json.
// With --largest only the view with the most boxes is kept, so a large reference map stays a small fixture.
// Usage: bun scripts/web-fixture.ts WORKSPACE OUT [--largest]
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { overviewId, selectView } from "../src/catalog";
import { loadWebWorld } from "../src/web/server";
import { sceneOf, viewOrder } from "../src/web/scene";

const [workspace, out, flag] = process.argv.slice(2);
if (!workspace || !out) throw new Error("Usage: bun scripts/web-fixture.ts WORKSPACE OUT [--largest]");
const json = await Effect.runPromise(Effect.gen(function* () {
  const view = yield* selectView(workspace, yield* overviewId(workspace), undefined);
  const { layouted, colors, palettes } = yield* loadWebWorld(view);
  let views = viewOrder([...layouted.values()].map(entry => sceneOf(entry, colors, palettes.dark)), view.id);
  if (flag === "--largest") views = [views.reduce((a, b) => b.nodes.length > a.nodes.length ? b : a)];
  return JSON.stringify({ project: view.project, palette: palettes.dark, views });
}));
await writeFile(out, `${json}\n`);
console.log(`${out}: ${json.length} bytes`);
