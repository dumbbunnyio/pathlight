import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { askMessage } from "../src/ask";
import { run } from "./effects";

test("an ask message leads with the question, adds the component's context, and carries no control characters", () => {
  const text = askMessage({ title: "Orders\x1b[31m", id: "parcel.orders", files: ["src/orders.ts"], links: ["→ Stock", "← Checkout API"] },
    "Why is\nthis\x07 slow?");
  expect(text).toBe('About the "Orders [31m" component (parcel.orders): Why is this slow? [files: src/orders.ts; connects: → Stock, ← Checkout API]');
  expect(text).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f]/);
});

test("t types a question about the selected node into the harness pane; Alt+Enter also submits it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-ask-"));
  const socket = join("/tmp", `c4a-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    // `cat` stands in for the agent harness: it echoes whatever is typed into its pane.
    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "ask-test", "-x", "170", "-y", "44", "-P", "-F", "#{pane_id}", "cat");
    const shown = JSON.parse(await run(process.execPath, [resolve("src/cli.ts"), "show", "live", "--workspace", directory,
      "--project", "viewer", "--pane", harness, "--socket", socket])) as { pane: string };
    const until = async (pane: string, predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(shown.pane, text => text.includes("Selected: plugin"), "viewer");
    await delay(700);
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(shown.pane, text => text.includes("Enter types it into your agent prompt"), "ask prompt");
    await tmux("send-keys", "-t", shown.pane, "-l", "why does this exist?");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const typed = await until(harness, text => text.includes("why does this exist?"), "text in the harness pane");
    const joined = typed.replace(/\n/g, "");
    expect(joined).toContain('About the "Agent adapters" component (plugin): why does this exist?');
    expect(joined).toContain("connects: → Activity metadata, → tmux launcher");
    await until(shown.pane, text => text.includes("press Enter there to send"), "typed-not-sent notice");
    // Without Alt the text is only typed: cat has not received a newline, so it has not echoed the line back.
    expect(typed.match(/About the "Agent adapters"/g)).toHaveLength(1);
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(shown.pane, text => text.includes("Enter types it into your agent prompt"), "second ask prompt");
    await tmux("send-keys", "-t", shown.pane, "-l", "second one");
    await tmux("send-keys", "-t", shown.pane, "M-Enter");
    await until(shown.pane, text => text.includes("Sent to"), "sent notice");
    const submitted = await until(harness, text => (text.replace(/\n/g, "").match(/second one/g) ?? []).length >= 2, "submitted line echoed back");
    expect(submitted.replace(/\n/g, "")).toContain("second one");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
