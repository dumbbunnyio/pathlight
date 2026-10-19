import { expect, test } from "bun:test";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("hjkl select the neighbouring node, arrows pan without selecting, and v swaps the roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-traverse-"));
  const socket = join("/tmp", `c4t-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "traverse-test", "-x", "120", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "services", "--project", "parcel", "--workspace", directory);
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (text: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await screen();
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    const press = async (...keys: string[]) => { await tmux("send-keys", "-t", pane, ...keys); await delay(500); };
    await until("Selected: customer");
    await delay(700);
    await press("l"); await until("Selected: parcel.storefront");
    await press("l"); await until("Selected: parcel.commerce.api");
    await press("l"); await until("Selected: parcel.commerce.inventory");
    await press("j"); await until("Selected: payments");
    await press("j"); await until("Nothing below");
    await press("h"); await until("Selected: parcel.commerce.api");
    await press("k"); await until("Selected: parcel.commerce.relay");

    const before = await screen();
    await press("Right", "Right");
    const panned = await screen();
    expect(panned).toContain("Selected: parcel.commerce.relay");
    expect(panned.split("\n").slice(3, 38).join("\n")).not.toBe(before.split("\n").slice(3, 38).join("\n"));

    await press("v");
    await until("Arrows select nodes, hjkl pan");
    await press("Left"); await until("Selected:");
    expect(await screen()).not.toContain("Selected: parcel.commerce.relay");
    await press("v");
    await press("l"); await until("Selected:");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
