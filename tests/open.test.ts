import { expect, test } from "bun:test";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// `open` turns the pane it was typed in into the viewer, but splits beside an agent that ran it for you.
test("open takes over a shell pane, and splits when an agent runs it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-open-"));
  const socket = join("/tmp", `c4o-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const cli = `${process.execPath} ${resolve("src/cli.ts")}`;
  const panes = async () => (await tmux("list-panes", "-a", "-F", "#{pane_id}")).trim().split("\n");
  const until = async (pane: string, text: string) => {
    let output = "";
    for (let attempt = 0; attempt < 160; attempt++) {
      output = await tmux("capture-pane", "-p", "-t", pane);
      if (output.includes(text)) return output;
      await delay(50);
    }
    throw new Error(`Missing ${text}:\n${output}`);
  };
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    const shell = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "open-test", "-x", "140", "-y", "40", "-c", directory, "-P", "-F", "#{pane_id}", "sh");
    await delay(300);

    // Typed at the prompt: this pane becomes the viewer and no pane is added.
    await tmux("send-keys", "-t", shell, `${cli} open --project parcel`, "Enter");
    await until(shell, "Service architecture").catch(() => until(shell, "System context"));
    expect(await panes()).toEqual([shell]);
    await tmux("send-keys", "-t", shell, "q");
    await until(shell, "$");

    // Run by something else in between (as an agent's shell tool is): a viewer pane is split off beside it.
    await tmux("send-keys", "-t", shell, `sh -c '${cli} open --project parcel; true'`, "Enter");
    for (let attempt = 0; attempt < 160 && (await panes()).length < 2; attempt++) await delay(50);
    const all = await panes();
    expect(all.length).toBe(2);
    const viewer = all.find(pane => pane !== shell)!;
    await until(viewer, "pathlight");
    expect(await tmux("capture-pane", "-p", "-t", shell)).not.toContain("System context");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
