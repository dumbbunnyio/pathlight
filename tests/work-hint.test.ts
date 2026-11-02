import { expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { recordSession } from "../src/sessions";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

// Work in a component that this view does not show is offered, never taken: a hint names the view, and `w` goes there and selects the component.
// The offer is lit only while the session's turn is open (the hooks write `ended: null` when a prompt begins).
test("work outside the view shows a hint and w switches to the view that has it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-work-hint-"));
  const socket = join("/tmp", `c4h-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer\n    autoLayout LeftRight\n  }\n}\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work-hint", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--workspace", directory, "--session", "work", "--source", "claude");
    const until = async (text: string, absent = false) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text) !== absent) return output;
        await delay(50);
      }
      throw new Error(`${absent ? "Still has" : "Missing"} ${text}:\n${output}`);
    };
    const call = async (id: string, file: string) => {
      const input = { file_path: join(directory, file) };
      await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "work" }, id, "Read", input, "started"));
      await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "work" }, id, "Read", input, "completed"));
    };
    await Effect.runPromise(recordSession(directory, { source: "claude", session: "work" }, { ended: null }));
    await until("Launch path");
    await call("one", "src/launcher.ts");
    await until("Pathlight implementation", true);
    expect(await tmux("capture-pane", "-p", "-t", pane)).not.toContain("working in");
    await call("two", "src/activity.ts");
    await until("working in Pathlight implementation");
    expect(await tmux("capture-pane", "-p", "-t", pane)).toContain("go and follow");
    // Nothing moved by itself.
    expect(await tmux("capture-pane", "-p", "-t", pane)).toContain("Launch path");
    await tmux("send-keys", "-t", pane, "w");
    await until("Selected: activity");
    // Going to the work is asking to watch it: follow is on, and `a` stops it, said on the news line.
    await until("following Activity metadata");
    expect(await tmux("capture-pane", "-p", "-t", pane)).toContain("Pathlight implementation");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("once the turn has ended the work is not offered and a finished call puts nothing in the header, and w still goes to it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-work-ended-"));
  const socket = join("/tmp", `c4e-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer\n    autoLayout LeftRight\n  }\n}\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    // A call from a turn that is over, then the viewer opens against that session.
    const binding = { source: "claude" as const, session: "ended" };
    const input = { file_path: join(directory, "src/activity.ts") };
    await writeActivity(directory, await toolActivity(directory, binding, "old", "Read", input, "started"));
    await writeActivity(directory, await toolActivity(directory, binding, "old", "Read", input, "completed"));
    await Effect.runPromise(recordSession(directory, binding, { ended: Date.now() }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work-ended", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--workspace", directory, "--session", "ended", "--source", "claude");
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
    // The session's calls are loaded (the inspector offers them); a call with an outcome puts nothing in the header.
    const screen = await until("c session");
    expect(screen.split("\n")[1]).not.toMatch(/now|last|read/);
    expect(screen).not.toContain("working in");
    expect(screen).not.toContain("go and follow");
    // A new turn lights it; its end puts it out again.
    await Effect.runPromise(recordSession(directory, binding, { ended: null }));
    await until("working in Pathlight implementation");
    await Effect.runPromise(recordSession(directory, binding, { ended: Date.now() }));
    for (let attempt = 0; attempt < 100 && (await tmux("capture-pane", "-p", "-t", pane)).includes("working in"); attempt++) await delay(50);
    expect(await tmux("capture-pane", "-p", "-t", pane)).not.toContain("working in");
    await tmux("send-keys", "-t", pane, "w");
    await until("Selected: activity");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// The offer is for work the person has not gone to: after `w` and Back it stays away until a later call in a different box, and a new turn starts afresh.
test("after w and b the offer stays away until a later call in another box, and a new turn offers it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-work-gone-"));
  const socket = join("/tmp", `c4g-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer\n    autoLayout LeftRight\n  }\n}\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/plugin.ts", element: "plugin" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const binding = { source: "claude" as const, session: "gone" };
    await Effect.runPromise(recordSession(directory, binding, { ended: null }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work-gone", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--workspace", directory, "--session", "gone", "--source", "claude");
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (check: (text: string) => boolean, what: string) => {
      for (let attempt = 0; attempt < 100; attempt++) { const text = await screen(); if (check(text)) return text; await delay(50); }
      throw new Error(`Never saw ${what}:\n${await screen()}`);
    };
    const edit = async (id: string, file: string) => {
      const input = { file_path: join(directory, file) };
      await writeActivity(directory, toolActivity(directory, binding, id, "Edit", input, "started"));
      await writeActivity(directory, toolActivity(directory, binding, id, "Edit", input, "completed"));
    };
    await until(text => text.includes("Launch path"), "the small view");
    await edit("one", "src/activity.ts");
    await until(text => text.includes("working in Pathlight implementation"), "the offer");
    await tmux("send-keys", "-t", pane, "w");
    await until(text => text.includes("Selected: activity"), "the work");
    await tmux("send-keys", "-t", pane, "b");
    await until(text => text.includes("Launch path") && !text.includes("back 1"), "back in the small view");
    // `w` turned follow on; turn it off, so what the news line shows is the offer alone.
    await until(text => text.includes("following Activity metadata"), "follow on");
    await tmux("send-keys", "-t", pane, "a");
    await until(text => text.includes("Follow off"), "follow off");
    await delay(800);
    expect(await screen()).not.toContain("working in");
    // Another call in the same box is the same work: still not offered.
    await edit("two", "src/activity.ts");
    await delay(800);
    expect(await screen()).not.toContain("working in");
    // A later call in a different box is new work.
    await edit("three", "src/plugin.ts");
    await until(text => text.includes("working in Pathlight implementation"), "the offer for new work");
    await tmux("send-keys", "-t", pane, "w");
    await until(text => text.includes("Selected: plugin"), "the new work");
    await tmux("send-keys", "-t", pane, "b");
    await until(text => text.includes("Launch path") && !text.includes("back 1"), "back again");
    await until(text => text.includes("following Agent adapters"), "follow on again");
    await tmux("send-keys", "-t", pane, "a");
    await until(text => text.includes("Follow off"), "follow off again");
    await delay(800);
    expect(await screen()).not.toContain("working in");
    // A new turn starts afresh: the newest work is offered again.
    await Effect.runPromise(recordSession(directory, binding, { ended: Date.now() }));
    await delay(600);
    await Effect.runPromise(recordSession(directory, binding, { ended: null }));
    await until(text => text.includes("working in Pathlight implementation"), "the offer in a new turn");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
