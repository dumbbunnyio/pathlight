import { expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { recordSession } from "../src/sessions";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

// Work is edits and commands. A session that only reads shows nothing live: no Work row, no tag or count on a card, no news line, no offer, and
// follow does not move for it. The read is still in the journal, and `c` counts it.
test("a read-only session shows nothing on the cards, the header or the Work card, follow stays, and c counts the reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-reads-"));
  const socket = join("/tmp", `c4r-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer\n    autoLayout LeftRight\n  }\n}\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const binding = { source: "claude" as const, session: "reads" };
    await Effect.runPromise(recordSession(directory, binding, { ended: null }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "reads", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--workspace", directory, "--session", "reads", "--source", "claude", "--select", "launcher");
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (check: (text: string) => boolean, what: string) => {
      for (let attempt = 0; attempt < 100; attempt++) { const text = await screen(); if (check(text)) return text; await delay(50); }
      throw new Error(`Never saw ${what}:\n${await screen()}`);
    };
    await until(text => text.includes("Launch path") && text.includes("Selected: launcher"), "the small view");
    await tmux("send-keys", "-t", pane, "a");
    await until(text => text.includes("following"), "follow on");
    const read = async (id: string, file: string, phase: "started" | "completed") =>
      writeActivity(directory, toolActivity(directory, binding, id, "Read", { file_path: join(directory, file) }, phase));
    // A read running in the selected box, and one finished in a box another view draws.
    await read("here", "src/launcher.ts", "started");
    await read("there", "src/activity.ts", "started");
    await read("there", "src/activity.ts", "completed");
    await delay(1_500);
    const shown = await screen();
    expect(shown.split("\n")[1]).not.toMatch(/now|read|working in/);
    expect(shown).not.toContain("◦");
    expect(shown).not.toMatch(/\br1\b/);
    expect(shown).toContain("Work");
    expect(shown).toContain("nothing observed here yet");
    expect(shown).toContain("Launch path");
    expect(shown).toContain("Selected: launcher");
    // `c` still counts them.
    await tmux("send-keys", "-t", pane, "c");
    const summary = await until(text => text.includes("components touched"), "the session summary");
    expect(summary).toMatch(/Activity metadata\s+r1/);
    expect(summary).toMatch(/tmux launcher\s+r1/);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
