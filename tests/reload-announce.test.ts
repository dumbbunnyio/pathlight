import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { newElsewhere } from "../src/viewer/where";
import { run } from "./effects";

// Phase 6 step 4: a box the end of a turn drew announces itself: the news line (header line 2) names it, never the footer, and with follow on the
// camera goes to it without selecting it. With follow off the camera stays where the person put it.
const cli = (directory: string, ...args: string[]) => Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args, "--workspace", directory], { stdout: "pipe", stderr: "pipe" });

const shop = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-announce-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop" }));
  for (const part of ["api", "store", "mail", "cart"]) {
    await mkdir(join(directory, `src/${part}`), { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/${part}/${name}.ts`), part === "store" ? "export const save = () => 1;\n" : `import { save } from "../store/${name}";\nexport const h = () => save();\n`);
  }
  expect(cli(directory, "draft").exitCode).toBe(0);
  return directory;
};

const watch = async (follow: boolean) => {
  const directory = await shop();
  const socket = join("/tmp", `c4an-${process.pid}-${follow ? "f" : "n"}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "announce", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "index", "--workspace", directory, "--session", "turn", "--source", "claude");
    const screen = async () => (await tmux("capture-pane", "-p", "-t", pane)).split("\n");
    const until = async (predicate: (lines: string[]) => boolean, label: string) => {
      let lines: string[] = [];
      for (let attempt = 0; attempt < 160; attempt++) { lines = await screen(); if (predicate(lines)) return lines; await delay(50); }
      throw new Error(`Missing ${label}:\n${lines.join("\n")}`);
    };
    await until(lines => lines.some(line => line.includes("Selected:")), "the viewer");
    await delay(900);
    // Zoomed in on the top left corner: the person has put the camera somewhere.
    await tmux("send-keys", "-t", pane, "+", "+", "+", "+");
    await until(lines => lines.some(line => /zoom (2|3)\d\d%/.test(line)), "the zoom");
    if (follow) { await tmux("send-keys", "-t", pane, "a"); await until(lines => lines.some(line => line.includes("following")), "follow on"); }
    const selected = (await screen()).join("\n").match(/Selected: (\S+)/)?.[1];

    // The agent's turn ends: a folder no box claims, and the end of the turn redraws.
    await mkdir(join(directory, "src/zebra"), { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/zebra/${name}.ts`), `import { save } from "../store/${name}";\nexport const z = () => save();\n`);
    expect(cli(directory, "refresh").exitCode).toBe(0);
    const after = await until(lines => lines[1]!.includes("+ zebra"), "the new box on the news line");
    expect(after.at(-1)).not.toContain("zebra");
    expect(after.join("\n").match(/Selected: (\S+)/)?.[1]).toBe(selected);
    await delay(800);
    // Whether the new card is on screen: its title inside a card's border, below the header.
    return (await screen()).slice(3).some(line => /│ zebra\s/.test(line));
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
};

test("a reload that adds a box names it on the news line and, with follow on, brings it into view without selecting it", async () => {
  expect(await watch(true)).toBe(true);
}, 90_000);

test("with follow off, a reload that adds a box leaves the camera where the person put it", async () => {
  expect(await watch(false)).toBe(false);
}, 90_000);

// Phase 6 step 7: a box new to the model that the view on screen does not draw (left out as minor, or in another package's view) is still named on
// the news line, with the view that draws it; follow goes there and brings it on screen, selecting nothing; with follow off nothing moves.
test("only boxes new to the model and not drawn here are announced elsewhere, each with the view that draws it", () => {
  const node = (id: string, title = id.split(".").at(-1)!) => ({ id, modelRef: id, children: [], title });
  const views = new Map([
    ["index", { id: "index", title: "Packages", nodes: [node("api"), node("web")] }],
    ["api_components", { id: "api_components", title: "api", viewOf: "api", nodes: [node("api"), node("api.routes"), node("api.zebra", "Zebra")] }],
    ["web_components", { id: "web_components", title: "web", viewOf: "web", nodes: [node("web"), node("web.routes"), node("web.yak"), node("api.routes")] }],
    ["everything", { id: "everything", title: "everything", nodes: [node("api"), node("web"), node("api.routes"), node("api.zebra"), node("web.routes"), node("web.yak"), node("web.owl")] }],
  ]);
  const before = new Set(["api", "web", "api.routes", "web.routes", "web.owl"]);
  // web.yak is new but drawn here (announced as this view's own card); web.owl is only elsewhere but was there before.
  expect(newElsewhere(views, views.get("web_components")!, before).map(box => [box.element, box.title, box.viewId, box.view])).toEqual([["api.zebra", "Zebra", "api_components", "api"]]);
});

const twoPackages = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-elsewhere-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop", workspaces: ["packages/*"] }));
  for (const pkg of ["web", "api"]) {
    await mkdir(join(directory, "packages", pkg), { recursive: true });
    await writeFile(join(directory, "packages", pkg, "package.json"), JSON.stringify({ name: pkg }));
    for (const part of ["routes", "store", "mail"]) {
      await mkdir(join(directory, `packages/${pkg}/src/${part}`), { recursive: true });
      for (const name of ["a", "b", "c"]) await writeFile(join(directory, `packages/${pkg}/src/${part}/${name}.ts`), `export const ${name} = () => 1;\n`);
    }
  }
  expect(cli(directory, "draft").exitCode).toBe(0);
  return directory;
};

const watchElsewhere = async (follow: boolean) => {
  const directory = await twoPackages();
  const socket = join("/tmp", `c4el-${process.pid}-${follow ? "f" : "n"}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    // The viewer is on web's view; the turn adds a folder to api, which only api's view draws.
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "elsewhere", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "web_components", "--workspace", directory, "--session", "turn", "--source", "claude");
    const screen = async () => (await tmux("capture-pane", "-p", "-t", pane)).split("\n");
    const until = async (predicate: (lines: string[]) => boolean, label: string) => {
      let lines: string[] = [];
      for (let attempt = 0; attempt < 160; attempt++) { lines = await screen(); if (predicate(lines)) return lines; await delay(50); }
      throw new Error(`Missing ${label}:\n${lines.join("\n")}`);
    };
    await until(lines => lines.some(line => line.includes("Selected:")), "the viewer");
    await delay(900);
    await tmux("send-keys", "-t", pane, "+", "+");
    await until(lines => lines.some(line => /zoom [1-9]\d\d%/.test(line)), "the zoom");
    if (follow) { await tmux("send-keys", "-t", pane, "a"); await until(lines => lines.some(line => line.includes("following")), "follow on"); }
    await delay(600);
    const start = await screen();
    const selected = start.join("\n").match(/Selected: (\S+)/)?.[1], zoom = start.at(-1)!.match(/zoom \d+%/)?.[0];

    await mkdir(join(directory, "packages/api/src/zebra"), { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, `packages/api/src/zebra/${name}.ts`), `export const z${name} = 1;\n`);
    expect(cli(directory, "refresh").exitCode).toBe(0);
    const after = await until(lines => /\+ zebra in api/.test(lines[1]!), "the new box and its view on the news line");
    expect(after.at(-1)).not.toContain("zebra");
    await delay(800);
    const end = await screen();
    return { title: end[0]!, selected: end.join("\n").match(/Selected: (\S+)/)?.[1], before: selected, zoom: end.at(-1)!.match(/zoom \d+%/)?.[0], zoomBefore: zoom,
      card: end.slice(3).some(line => /│ zebra\s/.test(line)) };
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
};

test("with follow on, a reload that adds a box only another view draws goes to that view and shows it without selecting it", async () => {
  const seen = await watchElsewhere(true);
  expect(seen.title).toMatch(/\/ api\b/);
  expect(seen.card).toBe(true);
  expect(seen.selected).toBeDefined();
  expect(seen.selected).not.toContain("zebra");
}, 90_000);

test("with follow off, a reload that adds a box only another view draws names it and moves nothing", async () => {
  const seen = await watchElsewhere(false);
  expect(seen.title).toMatch(/\/ web\b/);
  expect(seen.selected).toBe(seen.before);
  expect(seen.zoom).toBe(seen.zoomBefore);
  expect(seen.card).toBe(false);
}, 90_000);
