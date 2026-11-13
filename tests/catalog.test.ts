import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { listViews } from "../src/catalog";

const model = (element: string, view: string) =>
  `specification { element component }\nmodel { ${element} = component "${element}" }\nviews { view ${view} { include * } }\n`;

const workspace = async (files: Record<string, string>) => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-ignored-c4-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  expect(spawnSync("git", ["init", "-q", directory]).status).toBe(0);
  return directory;
};

test("an ignored .c4 file in .pathlight/ or in a workspace with no project is still read", async () => {
  // A person's model in arch/, and an agent-written journey in an ignored .pathlight/ with no config of its own. LikeC4's
  // `default` project does not draw such a file's views, so being read shows as its error, which the journey here has.
  const beside = await workspace({
    ".gitignore": ".pathlight/\n",
    "arch/likec4.config.json": JSON.stringify({ name: "arch" }),
    "arch/model.c4": model("api", "index"),
    ".pathlight/journey.behavior.c4": "views { dynamic view journey { customer -> api 'calls' } }\n",
  });
  // No project anywhere: the ignored files are the model.
  const alone = await workspace({ ".gitignore": "scratch/\n", "scratch/model.c4": model("solo", "index") });
  try {
    const listed = async (directory: string) => (await Effect.runPromise(listViews(directory))).views.map(view => `${view.project}/${view.id}`).sort();
    expect(String(await Effect.runPromise(Effect.flip(listViews(beside))))).toContain(".pathlight/journey.behavior.c4");
    expect(await listed(alone)).toEqual(["default/index"]);
  } finally {
    await rm(beside, { recursive: true, force: true });
    await rm(alone, { recursive: true, force: true });
  }
}, 30_000);

test("a .c4 file git ignores outside every project's folder is left out, and an ignored model with its own config or in .pathlight still loads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-ignored-c4-"));
  try {
    const files: Record<string, string> = {
      ".gitignore": ".pathlight/\nscratch/\nprivate/\n",
      ".pathlight/likec4.config.json": JSON.stringify({ name: "app" }),
      ".pathlight/pathlight.model.c4": model("api", "index"),
      // Someone's scratch: it names elements no project in reach defines, so it does not compile.
      "scratch/flows.c4": "views { dynamic view journey { customer -> parcel 'places an order' } }\n",
      // A model a person keeps and ignores on purpose, as its own project.
      "private/likec4.config.json": JSON.stringify({ name: "kept" }),
      "private/model.c4": model("vault", "index"),
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), text);
    }
    expect(spawnSync("git", ["init", "-q", directory]).status).toBe(0);
    const { views } = await Effect.runPromise(listViews(directory));
    expect(views.map(view => `${view.project}/${view.id}`).sort()).toEqual(["app/index", "kept/index"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
