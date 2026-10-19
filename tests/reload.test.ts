import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("editing the model reloads the diagram in place, keeps selection and zoom, and survives a broken model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-reload-"));
  const socket = join("/tmp", `c4r-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "reload-test", "-x", "170", "-y", "44", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer", "--workspace", directory);
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 160; attempt++) {
        output = await screen();
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(text => text.includes("Selected: plugin"), "viewer");
    await delay(800);
    await tmux("send-keys", "-t", pane, "0", "+");
    await until(text => text.includes("zoom 125%"), "zoom");
    const model = join(directory, "model.c4");
    const original = await readFile(model, "utf8");

    await writeFile(model, original.replace("  viewer = component 'Persistent viewer'", "  billing = component 'Billing service'\n  viewer = component 'Persistent viewer'")
      .replace("  activity -> viewer 'Updates component activity'", "  activity -> viewer 'Updates component activity'\n  billing -> launcher 'Charges'"));
    const added = await until(text => text.includes("+ Billing service"), "reload notice for the new node");
    expect(added).toContain("Selected: plugin");
    expect(added).toContain("zoom 125%");
    await until(text => text.includes("7 nodes"), "new node counted");

    await writeFile(model, "model { this is not valid");
    await until(text => text.includes("model has errors"), "error notice");
    expect(await screen()).toContain("7 nodes");

    await writeFile(model, original);
    await until(text => text.includes("6 nodes"), "recovery");
    expect(await screen()).toContain("Selected: plugin");

    // The activity mapping reloads too: a new glob changes the selected node's file list.
    await tmux("send-keys", "-t", pane, "e");
    await until(text => /Files[─\s]+0\/0/.test(text), "no mapped files yet");
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "model.c4", element: "plugin" }] }));
    await until(text => text.includes("model.c4"), "new mapping applied");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
