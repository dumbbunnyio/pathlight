import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("g lists every view in the project and jumps by number or Enter, keeping Back history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-goto-"));
  const socket = join("/tmp", `c4g-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "goto", "-x", "130", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "index", "--project", "parcel", "--workspace", directory);
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await screen();
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(text => text.includes("parcel/index") && text.includes("back 0"), "index view");
    await delay(800);
    await tmux("send-keys", "-t", pane, "g");
    const listing = await until(text => text.includes("Go to view"), "view list");
    for (const title of ["System context", "Service architecture", "Checkout detail"]) expect(listing).toContain(title);
    expect(listing).toMatch(/System context\s+index\s+\d+ nodes\s+● here/);
    await tmux("send-keys", "-t", pane, "3");
    await until(text => text.includes("parcel/checkout") && text.includes("back 1"), "checkout view after pressing 3");
    await tmux("send-keys", "-t", pane, "g");
    await until(text => text.includes("Go to view"), "view list again");
    await tmux("send-keys", "-t", pane, "Down", "Down", "Enter");
    await until(text => text.includes("parcel/"), "view after arrows");
    await tmux("send-keys", "-t", pane, "b");
    await until(text => text.includes("parcel/checkout"), "back to checkout");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
