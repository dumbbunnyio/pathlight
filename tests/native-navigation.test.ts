import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

test("search, hierarchy, and linked views preserve the Three camera and bound activity", async () => {
  const directory = await mkdtemp("/tmp/opencode/three-navigation-");
  const tmux = (...args: string[]) => run("tmux", ["-S", join(directory, "tmux.sock"), ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/api.ts"), "export {};\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "parcel",
      mappings: [{ glob: "src/api.ts", element: "parcel.commerce.api" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "navigation", "-x", "180", "-y", "46",
      "-e", "VISUAL=nvim -u NONE -i NONE -n", "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", "services",
      "--workspace", directory, "--project", "parcel", "--session", "navigation", "--source", "claude", "--select", "customer");
    const capture = async (text: string | RegExp) => {
      let output = "";
      for (let attempt = 0; attempt < 160; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (typeof text === "string" ? output.includes(text) : text.test(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    const find = async (query: string) => {
      await tmux("send-keys", "-t", pane, "/");
      await tmux("send-keys", "-t", pane, "-l", query);
    };
    const settled = async () => { await delay(700); return tmux("capture-pane", "-p", "-t", pane); };
    await capture("parcel/services");
    const initial = await settled();
    await find("qbohjkl");
    expect(await capture("Nothing matches")).toContain("qbohjkl");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("Nothing matches")).toContain("Selected: customer");
    await tmux("send-keys", "-t", pane, "Escape");
    expect(await settled()).toBe(initial);

    await find("commerce");
    await capture("› commerce");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("Selected: parcel.commerce")).toContain("parcel/services");
    expect(await capture("parcel/services")).not.toContain("back ");
    // Enter on a box that opens a view opens it, even a group with children here; backspace comes back.
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("parcel/checkout");
    await tmux("send-keys", "-t", pane, "BSpace");
    await settled();
    await tmux("send-keys", "-t", pane, "+", "Right");
    const beforeLink = await settled();
    expect(beforeLink).toContain("Selected: parcel.commerce");
    const pid = await tmux("display-message", "-p", "-t", pane, "#{pane_pid}");

    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("parcel/checkout")).toContain("back 1");
    await settled();
    await tmux("send-keys", "-t", pane, "b");
    await capture("parcel/services");
    expect(await settled()).toBe(beforeLink);

    await find("Checkout API");
    await capture("› Checkout API");
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "36");
    await settled();
    await tmux("resize-window", "-t", pane, "-x", "180", "-y", "46");
    await settled();
    await tmux("send-keys", "-t", pane, "Escape");
    expect(await settled()).toBe(beforeLink);
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("parcel/checkout");
    await find("parcel.commerce.api");
    await capture("› parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "Enter");
    const selectedApi = await settled();
    expect(selectedApi).toContain("parcel/checkout");
    const event = await toolActivity(directory, { source: "claude", session: "navigation" }, "edit-1", "Edit",
      { file_path: join(directory, "src/api.ts") }, "started");
    await writeActivity(directory, event);
    await capture(/─ ■/);
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("parcel/services");
    await tmux("send-keys", "-t", pane, "b");
    const restored = await capture(/parcel\/checkout[\s\S]*Selected: parcel\.commerce\.api/);
    expect(restored).toContain("parcel/checkout");
    expect(restored).toMatch(/─ ■/);
    expect(restored.match(/zoom \d+%/)?.[0]).toBe(selectedApi.match(/zoom \d+%/)?.[0]);
    await tmux("send-keys", "-t", pane, "e");
    await capture(/› [├└]─ api\.ts/);
    await tmux("send-keys", "-t", pane, "Enter");
    await delay(400);
    await tmux("send-keys", "-t", pane, "Escape", ":q", "Enter");
    expect(await capture("Returned from editor: src/api.ts")).toContain("Selected: parcel.commerce.api");
    await writeActivity(directory, { ...event, phase: "failed", time: Date.now() });
    await capture(/─ ✗/);
    expect(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(pid);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);

// `b` and backspace are one stack: backspace steps back through the visits as `b` does, and only with none left goes up, first to the box that holds
// the selection in this view, then to the view whose box opens this one. `b` with nothing to go back to stays and says so.
test("backspace steps back like b, and goes up only when there is nowhere to go back to", async () => {
  const see = async (keys: string) => (await run(process.execPath, [resolve("src/cli.ts"), "see", "checkout", "--workspace", "examples/parcel", "--project", "parcel",
    "--cols", "140", "--rows", "36", "--select", "parcel.commerce.api", "--keys", keys])).split("\n");
  const where = (screen: string[]) => [screen.find(line => line.includes("parcel/"))!.trim().split(" ")[0], /Selected: (\S+)/.exec(screen.at(-1)!)?.[1]];
  // Up through the boxes that hold the API in this view, then to the view whose box opens it.
  expect(where(await see("BSpace,BSpace"))).toEqual(["parcel/checkout", "parcel"]);
  const up = await see("BSpace,BSpace,BSpace");
  expect(where(up)).toEqual(["parcel/services", "parcel.commerce"]);
  expect(up.at(-1)).toContain("Went to Parcel / Service architecture");
  // Into the linked view and straight back: backspace takes the visit, as b would.
  expect(where(await see("BSpace,BSpace,BSpace,Enter,BSpace"))).toEqual(["parcel/services", "parcel.commerce"]);
  expect(where(await see("BSpace,BSpace,BSpace,Enter,b"))).toEqual(["parcel/services", "parcel.commerce"]);
  // o is no key: Enter is the one way into a box.
  expect(where(await see("BSpace,BSpace,BSpace,o"))).toEqual(["parcel/services", "parcel.commerce"]);
  // b alone, with no visit behind it, stays.
  const stays = await see("b");
  expect(where(stays)).toEqual(["parcel/checkout", "parcel.commerce.api"]);
  expect(stays.at(-1)).toContain("No previous view");
}, 120_000);

// Enter into a group is a step on the back stack: b and backspace first reselect the frame in the same view, and only then leave it.
test("back after Enter into a group reselects the frame in the same view before leaving it", async () => {
  const see = async (keys: string) => (await run(process.execPath, [resolve("src/cli.ts"), "see", "checkout", "--workspace", "examples/parcel", "--project", "parcel",
    "--cols", "140", "--rows", "36", "--select", "parcel.commerce", "--keys", keys])).split("\n");
  const where = (screen: string[]) => [screen.find(line => line.includes("parcel/"))!.trim().split(" ")[0], /Selected: (\S+)/.exec(screen.at(-1)!)?.[1]];
  const inside = await see("Enter");
  expect(where(inside)[0]).toBe("parcel/checkout");
  expect(where(inside)[1]).toStartWith("parcel.commerce.");
  expect(inside.find(line => line.includes("parcel/checkout"))).toContain("back 1");
  expect(where(await see("Enter,b"))).toEqual(["parcel/checkout", "parcel.commerce"]);
  expect(where(await see("Enter,BSpace"))).toEqual(["parcel/checkout", "parcel.commerce"]);
  const twice = await see("Enter,b,b");
  expect(where(twice)).toEqual(["parcel/checkout", "parcel.commerce"]);
  expect(twice.at(-1)).toContain("No previous view");
}, 120_000);

// A click that changes the selection is a visit, as Enter is: b returns to what was selected before it, in the same view. A click on the selection adds nothing.
test("a mouse click that changes the selection is on the back stack", async () => {
  const directory = await mkdtemp("/tmp/opencode/click-visit-");
  const tmux = (...args: string[]) => run("tmux", ["-S", join(directory, "tmux.sock"), ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "click-visit", "-x", "150", "-y", "44", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer", "--workspace", directory, "--select", "plugin");
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    const click = (column: number, row: number) => tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    const at = (text: string, screen: string) => { const rows = screen.split("\n"), row = rows.findIndex(line => line.includes(text)); return { row, column: rows[row]!.indexOf(text) }; };
    const header = (screen: string) => screen.split("\n").slice(0, 3).join("\n");
    const start = await until(text => text.includes("Selected: plugin") && text.includes("LikeC4"), "the view");
    expect(header(start)).not.toContain("back ");
    const label = at("LikeC4", start);
    await click(label.column + 2, label.row);
    expect(header(await until(text => text.includes("Selected: catalog"), "the click"))).toContain("back 1");
    // Clicking what is already selected is no visit.
    await click(label.column + 2, label.row);
    await delay(300);
    expect(header(await until(text => text.includes("Selected: catalog"), "the same selection"))).toContain("back 1");
    await tmux("send-keys", "-t", pane, "b");
    const back = await until(text => text.includes("Selected: plugin"), "b after the click");
    expect(header(back)).not.toContain("back ");
    expect(back).toContain("live");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
