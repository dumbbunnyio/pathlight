import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { askMessage, flowMessage } from "../src/ask";
import { run, mappingIn } from "./effects";

test("an ask message leads with the question, adds the component's context, and carries no control characters", () => {
  const text = askMessage({ title: "Orders\x1b[31m", id: "parcel.orders", files: ["src/orders.ts"], links: ["→ Stock", "← Checkout API"] },
    "Why is\nthis\x07 slow?");
  expect(text).toBe('About the "Orders [31m" component (parcel.orders): Why is this slow? [files: src/orders.ts; connects: → Stock, ← Checkout API]');
  expect(text).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f]/);
});

test("t types a question about the selected node into the harness pane; Enter submits it and Alt+Enter adds a line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-ask-"));
  const socket = join("/tmp", `c4a-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer",
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
    await until(shown.pane, text => text.includes("Ask the agent"), "ask prompt");
    // An empty question does not send: the prompt stays open.
    await tmux("send-keys", "-t", shown.pane, "Enter");
    await delay(300);
    expect(await tmux("capture-pane", "-p", "-t", shown.pane)).toContain("Ask the agent");
    await tmux("send-keys", "-t", shown.pane, "-l", "why does this exist?");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const typed = await until(harness, text => (text.replace(/\n/g, "").match(/why does this exist\?/g) ?? []).length >= 2, "submitted line echoed back");
    const joined = typed.replace(/\n/g, "");
    expect(joined).toContain('About the "Agent adapters" component (plugin): why does this exist?');
    expect(joined).toContain("connects: → Activity metadata, → tmux launcher");
    const toast = await until(shown.pane, text => text.includes("Asked"), "asked toast");
    expect(toast).toContain("✓ Asked the agent about Agent adapters");
    expect(toast).not.toContain("Ask the agent");
    // Tab moves to the include row; Space turns connections off, so the next question carries no connections.
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(shown.pane, text => text.includes("Ask the agent"), "second ask prompt");
    await until(shown.pane, text => text.includes("● connections 2"), "connections on by default");
    await tmux("send-keys", "-t", shown.pane, "Tab", "Right", "Space");
    await until(shown.pane, text => text.includes("○ connections 2") && text.includes("← → choose"), "connections off, include row hints");
    await tmux("send-keys", "-t", shown.pane, "Tab");
    // Alt+Enter adds a line instead of sending.
    await tmux("send-keys", "-t", shown.pane, "-l", "second");
    await tmux("send-keys", "-t", shown.pane, "M-Enter");
    await tmux("send-keys", "-t", shown.pane, "-l", "one");
    await delay(300);
    expect(await tmux("capture-pane", "-p", "-t", shown.pane)).toContain("Ask the agent");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const submitted = await until(harness, text => (text.replace(/\n/g, "").match(/second one/g) ?? []).length >= 2, "second line echoed back");
    expect(submitted.replace(/\n/g, "").split("second one")[1]).not.toContain("connects:");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("d asks the agent to trace a flow: the request names the skill, the command and the component's files, and nothing is sent until Enter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-ask-flow-"));
  const socket = join("/tmp", `c4f-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "flow-test", "-x", "170", "-y", "44", "-P", "-F", "#{pane_id}", "cat");
    const shown = JSON.parse(await run(process.execPath, [resolve("src/cli.ts"), "show", "live", "--workspace", directory, "--project", "viewer", "--pane", harness, "--socket", socket])) as { pane: string };
    const until = async (pane: string, predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-J", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(shown.pane, text => text.includes("Selected: plugin"), "viewer");
    await delay(700);
    await tmux("send-keys", "-t", shown.pane, "d");
    await until(shown.pane, text => text.includes("Ask the agent to trace a flow"), "flow prompt");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    await delay(300);
    expect(await tmux("capture-pane", "-p", "-t", harness)).not.toContain("pathlight journey");
    await tmux("send-keys", "-t", shown.pane, "-l", "how an adapter records a call");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const typed = (await until(harness, text => text.replace(/\n/g, "").includes("Do not change product code."), "request echoed back")).replace(/\n/g, "");
    expect(typed).toContain('Trace how this works in the "Agent adapters" component (plugin) and record it as a pathlight journey: how an adapter records a call');
    expect(typed).toContain("pathlight flow add");
    expect(typed).toContain("pathlight-tracer agent");
    expect(typed).toContain("pathlight-behavior skill");
    await until(shown.pane, text => text.includes("Asked the agent to trace a flow"), "toast");
  } finally {
    await tmux("kill-server").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a flow request is one clean line that keeps the rules: confirm each hop in a file, name the files, change no product code", () => {
  const text = flowMessage({ title: "Orders\x1b[31m", id: "parcel.orders", files: ["src/orders.ts"], links: ["→ Stock"] }, "what\nhappens?");
  expect(text).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(text).toContain('"Orders [31m" component (parcel.orders)');
  expect(text).toContain("what happens? [files: src/orders.ts; connects: → Stock]");
  expect(text).toMatch(/confirm each hop in a file.*pathlight flow add.*Do not change product code\.$/);
});
