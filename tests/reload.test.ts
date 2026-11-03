import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, mappingIn } from "./effects";

test("editing the model reloads the diagram in place, keeps selection and zoom, and survives a broken model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-reload-"));
  const socket = join("/tmp", `c4r-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer",
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
    await until(text => text.includes("7 boxes"), "new node counted");

    await writeFile(model, "model { this is not valid");
    await until(text => text.includes("model has errors"), "error notice");
    expect(await screen()).toContain("7 boxes");

    await writeFile(model, original);
    await until(text => text.includes("6 boxes"), "recovery");
    expect(await screen()).toContain("Selected: plugin");

    // The activity mapping reloads too: a new glob changes the selected node's file list.
    await tmux("send-keys", "-t", pane, "e");
    await until(text => /Files[─\s]+0\/0/.test(text), "no mapped files yet");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "model.c4", element: "plugin" }] }));
    await until(text => text.includes("model.c4"), "new mapping applied");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("b after a reload that removed the view it would return to says there is nothing to go back to, and no key prints a stack trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-reload-back-"));
  const socket = join("/tmp", `c4rb-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const model = join(directory, "model.c4");
    const original = await readFile(model, "utf8");
    const extra = "  view extra {\n    title 'Extra view'\n    include launcher, viewer\n  }\n";
    await writeFile(model, original.replace("views {\n", `views {\n${extra}`));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "reload-back", "-x", "140", "-y", "36", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "extra", "--project", "viewer", "--workspace", directory);
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
    await until(text => text.includes("pathlight / Extra view"), "the extra view");
    await delay(500);
    // Go to the other view, so the extra view is in the history, then take it out of the model.
    await tmux("send-keys", "-t", pane, "g");
    await delay(300);
    await tmux("send-keys", "-t", pane, "-l", "Pathlight implementation");
    await delay(300);
    await tmux("send-keys", "-t", pane, "Enter");
    await until(text => text.includes("pathlight / Pathlight implementation") && text.includes("back 1"), "the live view, one visit back");
    await writeFile(model, original);
    await until(text => text.includes("pathlight / Pathlight implementation") && !text.includes("back 1"), "the reload, with the gone view out of the history");
    await tmux("send-keys", "-t", pane, "b");
    const after = await until(text => text.includes("No previous view"), "the notice");
    expect(after).not.toMatch(/at .*\.ts:\d+|Unknown linked view/);
    expect(after).toContain("pathlight / Pathlight implementation");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
