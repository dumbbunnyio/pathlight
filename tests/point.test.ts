import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// `pathlight point`: an agent walking a person through the map asks the open viewer to show one element. It is selected once and marked
// `← agent` until a key is pressed, and nothing afterwards follows the agent. The screen is captured as `pathlight see` captures it, so the marked
// screen can be kept as a golden beside the others.
test("point selects the element once with a visible mark, a key clears the mark, an unknown id moves nothing, and with no viewer it does nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-point-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, "-f", "/dev/null", ...args]);
  const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args, "--workspace", join(directory, "work")]);
  try {
    await cp("tests/fixtures/viewer", join(directory, "work"), { recursive: true });
    await mkdir(join(directory, "config"));
    await tmux("new-session", "-d", "-s", "point", "-x", "140", "-y", "36", "env", `XDG_CONFIG_HOME=${join(directory, "config")}`, "COLORTERM=truecolor",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", join(directory, "work"), "--project", "viewer", "--ready", join(directory, "ready.json"));
    const capture = async () => {
      await tmux("capture-pane", "-N", "-b", "screen", "-t", "point");
      await tmux("save-buffer", "-b", "screen", join(directory, "screen.txt"));
      return (await readFile(join(directory, "screen.txt"), "utf8")).replace(/(\n\s*)+$/, "\n");
    };
    const settled = async () => { let previous = await capture(); for (let attempt = 0; attempt < 40; attempt++) { await delay(150); const now = await capture(); if (now === previous) return now; previous = now; } return previous; };
    const until = async (check: (text: string) => boolean, what: string) => {
      for (let attempt = 0; attempt < 80; attempt++) { const text = await capture(); if (check(text)) return text; await delay(100); }
      throw new Error(`Never saw ${what}:\n${await capture()}`);
    };
    for (let attempt = 0; attempt < 100 && !(await readFile(join(directory, "ready.json"), "utf8").catch(() => "")); attempt++) await delay(100);
    const first = await settled();
    expect(first).toContain("Selected: plugin");

    expect(await cli("point", "launcher")).toBe("Pointed the viewer at launcher.");
    await until(text => text.includes("Selected: launcher"), "the pointed element selected");
    const marked = await settled();
    expect(marked.split("\n")[0]).toMatch(/◆ pathlight \/ Pathlight implementation +← agent: tmux launcher/);
    const golden = "tests/golden/pointed-140x36.txt";
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(golden, marked); else expect(marked).toBe(await readFile(golden, "utf8"));

    // The next key clears the mark and leaves the selection; nothing more happens until the agent points again.
    await tmux("send-keys", "-t", "point", "f");
    const cleared = await until(text => !text.includes("← agent"), "the mark cleared");
    expect(cleared).toContain("Selected: launcher");

    // An unknown id is refused by the command and moves nothing.
    await expect(cli("point", "nonesuch")).rejects.toThrow(/Unknown element: nonesuch/);
    await delay(800);
    expect(await capture()).toContain("Selected: launcher");

    // While help is open a pointer is let go, not kept for later.
    await tmux("send-keys", "-t", "point", "?");
    await until(text => text.includes("Keyboard shortcuts"), "help");
    await cli("point", "viewer");
    await delay(900);
    await tmux("send-keys", "-t", "point", "Escape");
    await delay(900);
    expect(await capture()).toContain("Selected: launcher");

    expect(await cli("point")).toBe("Pointer cleared.");
    await tmux("kill-server");
    await delay(300);
    expect(await cli("point", "launcher")).toBe("No viewer is open on this workspace, so nothing was pointed at. Open one with pathlight show or /pathlight:open.");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("on a drafted map a box's key from the brief names its element, and an unknown name is refused before anything is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-point-key-"));
  const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args, "--workspace", directory]);
  try {
    await mkdir(join(directory, "src", "session"), { recursive: true });
    await mkdir(join(directory, "src", "database"), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "demo" }));
    for (const [path, text] of [["src/session/run.ts", `import { db } from "../database/db";\nexport const run = db;\n`], ["src/session/stop.ts", "export const stop = 1;\n"],
      ["src/database/db.ts", "export const db = 1;\n"], ["src/database/query.ts", `import { db } from "./db";\nexport const q = db;\n`]]) await writeFile(join(directory, path!), text!);
    await cli("draft");
    // Resolved (no viewer is open, so nothing is written), where an unknown key is refused.
    expect(await cli("point", "src/session")).toStartWith("No viewer is open on this workspace");
    await expect(cli("point", "src/nowhere")).rejects.toThrow(/Unknown element: src\/nowhere/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

// A key is a path and can equal another box's id (Mealie's root package `mealie` and its backend, key `mealie`): that name is refused with both,
// and the id points.
test("a name that is one box's id and another box's key is refused naming both, and the id resolves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-point-clash-"));
  const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args, "--workspace", directory]);
  try {
    await mkdir(join(directory, ".cache", "pathlight"), { recursive: true });
    await writeFile(join(directory, "model.c4"), "specification { element component }\nmodel {\n  app = component 'App package' {\n    app = component 'Backend server'\n  }\n}\nviews { view index { include app, app.* } }\n");
    await writeFile(join(directory, ".cache", "pathlight", "keys.json"), JSON.stringify({ version: 1, keys: { app: ".", "app.app": "app" } }));
    await expect(cli("point", "app")).rejects.toThrow("`app` names two boxes: App package (say `.`) and Backend server (say `app.app`).");
    expect(await cli("point", "app.app")).toStartWith("No viewer is open on this workspace");
    expect(await cli("point", ".")).toStartWith("No viewer is open on this workspace");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

// A pointer can carry the journey step the agent is talking about: the viewer reads that journey at that step (flow mode, the step reader open, the
// `← agent` mark as before) and stays in it until esc or the next pointer; a pointer without a journey leaves it.
test("a pointer with a journey and a step turns flow mode on at that step, and esc or the next plain pointer leaves it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-point-step-"));
  const work = join(directory, "work"), socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, "-f", "/dev/null", ...args]);
  const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args, "--workspace", work]);
  try {
    await cp("examples/parcel", work, { recursive: true, filter: path => !path.includes(".cache") });
    await writeFile(join(work, "views.c4"), `${await readFile(join(work, "views.c4"), "utf8")}
views {
  dynamic view placeorder {
    title 'Placing an order'
    customer -> parcel.storefront 'opens checkout'
    parcel.storefront -> parcel.commerce.api 'submits the cart'
    parcel.commerce.api -> parcel.commerce.inventory 'reserves stock'
    parcel.commerce.api -> parcel.commerce.orders 'commits the order'
  }
}
`);
    await tmux("new-session", "-d", "-s", "step", "-x", "150", "-y", "40", process.execPath, resolve("src/cli.ts"), "view", "services", "--workspace", work, "--project", "parcel",
      "--select", "customer", "--ready", join(directory, "ready.json"));
    const capture = () => tmux("capture-pane", "-p", "-t", "step");
    const until = async (check: (text: string) => boolean, what: string) => {
      for (let attempt = 0; attempt < 100; attempt++) { const text = await capture(); if (check(text)) return text; await delay(100); }
      throw new Error(`Never saw ${what}:\n${await capture()}`);
    };
    for (let attempt = 0; attempt < 100 && !(await readFile(join(directory, "ready.json"), "utf8").catch(() => "")); attempt++) await delay(100);
    await until(text => text.includes("Selected: customer"), "the viewer");

    // The command checks the journey and the step before writing anything.
    await expect(cli("point", "parcel.commerce.api", "--journey", "nosuch", "--step", "1")).rejects.toThrow(/Unknown journey: nosuch/);
    await expect(cli("point", "parcel.commerce.api", "--journey", "placeorder", "--step", "9")).rejects.toThrow(/has 4 steps/);
    await expect(cli("point", "parcel.commerce.api", "--journey", "placeorder")).rejects.toThrow(/--journey and --step go together/);

    expect(await cli("point", "parcel.commerce.api", "--journey", "placeorder", "--step", "2")).toBe("Pointed the viewer at parcel.commerce.api, step 2 of placeorder.");
    expect(JSON.parse(await readFile(join(work, ".cache/pathlight/point.json"), "utf8"))).toMatchObject({ version: 1, element: "parcel.commerce.api", journey: "placeorder", step: 2 });
    const second = await until(text => text.includes("◇ Placing an order · 2/4"), "flow mode at step 2");
    expect(second).toMatch(/^ flow /m);
    expect(second).toContain("Selected: parcel.commerce.api");
    expect(second).toContain("← agent");
    expect(second).toContain("Steps");

    // The next step: the reader moves, flow mode stays.
    await cli("point", "parcel.commerce.orders", "--journey", "placeorder", "--step", "4");
    const fourth = await until(text => text.includes("◇ Placing an order · 4/4"), "flow mode at step 4");
    expect(fourth).toContain("Selected: parcel.commerce.orders");
    expect(fourth).toContain("← agent");

    // A key clears the mark, not the journey; esc leaves the journey.
    await tmux("send-keys", "-t", "step", "r");
    expect(await until(text => !text.includes("← agent"), "the mark cleared")).toContain("◇ Placing an order · 4/4");
    await tmux("send-keys", "-t", "step", "Escape");
    await until(text => /^ diagram /m.test(text), "flow mode left");

    // A plain pointer after a journey pointer leaves the journey.
    await cli("point", "parcel.storefront", "--journey", "placeorder", "--step", "1");
    await until(text => text.includes("◇ Placing an order · 1/4"), "flow mode again");
    await cli("point", "parcel.commerce.inventory");
    const plain = await until(text => text.includes("Selected: parcel.commerce.inventory"), "the plain pointer");
    expect(plain).toMatch(/^ diagram /m);
    expect(plain).toContain("← agent");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
