import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity } from "./effects";

test("search, hierarchy, and linked views preserve the Three camera and bound activity", async () => {
  const directory = await mkdtemp("/tmp/opencode/three-navigation-");
  const tmux = (...args: string[]) => run("tmux", ["-S", join(directory, "tmux.sock"), ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/api.ts"), "export {};\n");
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "parcel",
      mappings: [{ glob: "src/api.ts", element: "parcel.commerce.api" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "navigation", "-x", "180", "-y", "46",
      "-e", "VISUAL=nvim -u NONE -i NONE -n", "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", "services",
      "--workspace", directory, "--project", "parcel", "--session", "navigation", "--source", "claude");
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
    expect(await capture("No matches in this view")).toContain("Search 0/0");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("Search 0/0")).toContain("Selected: customer");
    await tmux("send-keys", "-t", pane, "Escape");
    expect(await settled()).toBe(initial);

    await find("commerce");
    expect(await capture("Search 1/6")).toContain("Selected: parcel.commerce");
    await tmux("send-keys", "-t", pane, "Up");
    await capture("Search 6/6");
    await tmux("send-keys", "-t", pane, "Down");
    await capture("Search 1/6");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("parcel/services")).toContain("back 0");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("Selected: parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "BSpace");
    await settled();
    await tmux("send-keys", "-t", pane, "+", "Right");
    const beforeLink = await settled();
    expect(beforeLink).toContain("Selected: parcel.commerce");
    const pid = await tmux("display-message", "-p", "-t", pane, "#{pane_pid}");

    await tmux("send-keys", "-t", pane, "o");
    expect(await capture("parcel/checkout")).toContain("back 1");
    await settled();
    await tmux("send-keys", "-t", pane, "b");
    await capture("parcel/services");
    expect(await settled()).toBe(beforeLink);

    await find("Checkout API");
    await capture("Search 1/1");
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "36");
    await settled();
    await tmux("resize-window", "-t", pane, "-x", "180", "-y", "46");
    await settled();
    await tmux("send-keys", "-t", pane, "Escape");
    expect(await settled()).toBe(beforeLink);
    await tmux("send-keys", "-t", pane, "o");
    await capture("parcel/checkout");
    await find("parcel.commerce.api");
    await capture("Search 1/1");
    await tmux("send-keys", "-t", pane, "Enter");
    const selectedApi = await settled();
    expect(selectedApi).toContain("parcel/checkout");
    const event = await toolActivity(directory, { source: "claude", session: "navigation" }, "edit-1", "Edit",
      { file_path: join(directory, "src/api.ts") }, "started");
    await writeActivity(directory, event);
    await capture("[edit]");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("parcel/services");
    await tmux("send-keys", "-t", pane, "b");
    const restored = await capture("Selected: parcel.commerce.api");
    expect(restored).toContain("parcel/checkout");
    expect(restored).toContain("[edit]");
    expect(restored.match(/zoom \d+%/)?.[0]).toBe(selectedApi.match(/zoom \d+%/)?.[0]);
    await tmux("send-keys", "-t", pane, "e");
    await capture(/› [├└]─ api\.ts/);
    await tmux("send-keys", "-t", pane, "Enter");
    await delay(400);
    await tmux("send-keys", "-t", pane, "Escape", ":q", "Enter");
    expect(await capture("Returned from editor: src/api.ts")).toContain("Selected: parcel.commerce.api");
    await writeActivity(directory, { ...event, phase: "failed", time: Date.now() });
    await capture("[failed]");
    expect(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(pid);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
