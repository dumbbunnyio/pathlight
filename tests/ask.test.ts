import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { askMessage, flowMessage, isHowQuestion, relevantFiles } from "../src/ask";
import { run, mappingIn } from "./effects";

test("an ask message leads with the question, adds the component's context, and carries no control characters", () => {
  const text = askMessage({ title: "Orders\x1b[31m", id: "parcel.orders", files: ["src/orders.ts"], links: ["→ Stock", "← Checkout API"] },
    "Why is\nthis\x07 slow?");
  expect(text.startsWith('About the "Orders [31m" component (parcel.orders): Why is this slow? [files: src/orders.ts; connects: → Stock, ← Checkout API] ')).toBe(true);
  expect(text).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f]/);
});

test("t asks or tells, and both close their loop: a drawn question is recorded as a journey, an instruction declares its plan before the first edit", () => {
  const target = { title: "Orders", id: "parcel.orders", files: ["src/orders.ts"], links: [] };
  const asked = askMessage(target, "how does an order reach shipping?", true);
  expect(asked).toContain("Answer here, and also record the path as a pathlight journey (pathlight flow add, as the pathlight skill says) so it appears on the map and F walks it.");
  expect(asked).toContain("If this asks you to change the code, before editing any file run pathlight plan parcel.orders with the ids of whatever else the change will reach, and add a #planned element with its mapping for anything new; run pathlight plan with no ids when done.");
  expect(askMessage(target, "why is it slow?")).not.toContain("pathlight journey");
  expect(askMessage(target, "add a refunds endpoint")).toContain("run pathlight plan parcel.orders");
  // Who records the journey is the skill's word to the conversation, never in a text a tracer is handed.
  for (const text of [asked, flowMessage(target, "how does an order reach shipping?")]) expect(text).not.toMatch(/tracer|hand (it|the trace|that)/i);
  expect(flowMessage(target, "x")).toContain("over http");
});

test("draw it starts on for a question that asks how something works or where it goes, and off otherwise", () => {
  for (const question of ["how does a call get recorded?", "How do orders ship", "where does the token go?", "What happens when I press save", "trace the checkout", "walk me through sign-in"])
    expect(isHowQuestion(question), question).toBe(true);
  for (const question of ["why does this exist?", "add a health-check route", "rename it to Store", "what is this?", "", "however you like"])
    expect(isHowQuestion(question), question).toBe(false);
});

test("a request names at most six files: those on the component's edges by how many imports cross there, then the entry its description names, else none", () => {
  const files = ["server/a.ts", "server/b.ts", "server/c.ts", "server/main.ts", "server/z.ts"];
  const imports = [
    { from: "app/x.ts", to: "server/b.ts", kind: "import" }, { from: "app/y.ts", to: "server/b.ts", kind: "import" }, { from: "server/c.ts", to: "app/x.ts", kind: "import" },
    { from: "app/x.ts", to: "server/a.ts", kind: "type" }, { from: "server/a.ts", to: "server/z.ts", kind: "import" }, { from: "lib/q.ts", to: "server/z.ts", kind: "import" },
  ];
  expect(relevantFiles({ files, neighbours: ["app/x.ts", "app/y.ts"], imports, description: "Koa server. Entry is server/main.ts. (inferred) · 5 files" }))
    .toEqual(["server/b.ts", "server/c.ts", "server/main.ts"]);
  expect(relevantFiles({ files, neighbours: [], imports, description: "Koa server." })).toEqual([]);
  expect(relevantFiles({ files, neighbours: [], imports, description: "Entry is elsewhere/main.ts." })).toEqual([]);
  const many = Array.from({ length: 9 }, (_, index) => `s/${index}.ts`);
  const picked = relevantFiles({ files: [...many, "s/main.ts"], neighbours: ["n.ts"], imports: many.map(file => ({ from: "n.ts", to: file })), description: "Entry is s/main.ts" });
  expect(picked).toEqual(["s/0.ts", "s/1.ts", "s/2.ts", "s/3.ts", "s/4.ts", "s/main.ts"]);
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
    // On first open t offers the first question about the box the view opens on, typed, with draw it on, so the first ask is one Enter.
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(shown.pane, text => text.includes("Ask the agent") && text.includes("● draw it"), "first question typed, draw it on");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const first = await until(harness, text => (text.replace(/\n/g, "").match(/how does Agent adapters work\?/g) ?? []).length >= 2, "first question echoed back");
    expect(first.replace(/\n/g, "")).toContain('About the "Agent adapters" component (plugin): how does Agent adapters work?');
    expect(first.replace(/\n/g, "")).toContain("also record the path as a pathlight journey");
    // Once asked, t opens empty.
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(shown.pane, text => text.includes("Ask the agent"), "ask prompt");
    // An empty question does not send: the prompt stays open.
    await tmux("send-keys", "-t", shown.pane, "Enter");
    await delay(300);
    expect(await tmux("capture-pane", "-p", "-t", shown.pane)).toContain("Ask the agent");
    await tmux("send-keys", "-t", shown.pane, "-l", "why does this exist?");
    await until(shown.pane, text => text.includes("○ draw it"), "draw it off for a why-question");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const typed = await until(harness, text => (text.replace(/\n/g, "").match(/why does this exist\?/g) ?? []).length >= 2, "submitted line echoed back");
    const joined = typed.replace(/\n/g, "");
    expect(joined).toContain('About the "Agent adapters" component (plugin): why does this exist?');
    expect(joined).toContain("connects: → Activity metadata, → tmux launcher");
    expect(joined).toContain("before editing any file run pathlight plan plugin");
    expect(joined.split("why does this exist?")[1]).not.toContain("pathlight journey");
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
    // A how-question turns draw it on; the user can flip it off and back, and the request then asks for the path to be recorded.
    await until(shown.pane, text => !text.includes("Ask the agent"), "dialog closed");
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(shown.pane, text => text.includes("Ask the agent"), "third ask prompt");
    await tmux("send-keys", "-t", shown.pane, "-l", "how is a call recorded?");
    await until(shown.pane, text => text.includes("● draw it"), "draw it on for a how-question");
    await tmux("send-keys", "-t", shown.pane, "Tab", "Right", "Right", "Right", "Space");
    await until(shown.pane, text => text.includes("○ draw it"), "draw it flipped off");
    await tmux("send-keys", "-t", shown.pane, "Space", "Tab");
    await until(shown.pane, text => text.includes("● draw it"), "draw it back on");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const drawn = await until(harness, text => (text.replace(/\n/g, "").match(/how is a call recorded\?/g) ?? []).length >= 2, "how-question echoed back");
    expect(drawn.replace(/\n/g, "").split("how is a call recorded?")[1]).toContain("also record the path as a pathlight journey");
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
    expect(typed).not.toContain("tracer");
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
