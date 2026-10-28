import { expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, mappingIn } from "./effects";

// An element designed but not built is shown as such: dashed, tagged `[planned]`, counted in the header, and described under its title in the inspector.
test("a planned element with no files is drawn as planned, and one that has files is not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-planned-view-"));
  const socket = join("/tmp", `c4p-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer, activity\n    autoLayout LeftRight\n  }\n}\n");
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/launcher.ts"), "export const l = 1;\n");
    await writeFile(join(directory, "src/viewer.ts"), "export const v = 1;\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", planned: ["activity"], mappings: [
      { glob: "src/launcher.ts", element: "launcher" }, { glob: "src/viewer.ts", element: "viewer" }, { glob: "src/activity.ts", element: "activity" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "planned", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--workspace", directory, "--select", "activity");
    const until = async (text: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await until("Launch path");
    const screen = await until("[planned]");
    expect(screen).toContain("1 planned");
    // Dashed border characters are what mark it: the other two are solid.
    expect(screen).toContain("┄");
    // Only the one element without files is tagged.
    expect((screen.match(/\[planned\]/g) ?? []).length).toBe(1);
    expect(await until("Selected: activity")).toContain("planned: no files yet");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
