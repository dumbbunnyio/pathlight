import { expect, test } from "bun:test";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  expect(asked).toContain('Load the pathlight skill and follow its "Requests from the viewer" section: answer here, and have the path recorded as a pathlight journey (pathlight flow add) so it appears on the map and F walks it.');
  expect(asked).toContain("If this asks you to change the code, before editing any file run pathlight plan parcel.orders with the ids of whatever else the change will reach, and add anything new as a planned element (the pathlight skill says how); run pathlight plan with no ids when done.");
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

test("test files come last in a request, however many neighbours import them", () => {
  // Outline's server: every plugin test imports server/test/factories.ts, which ranked it above the server's own entry.
  const files = ["server/main.ts", "server/test/factories.ts", "server/env.ts", "server/routes/auth.spec.ts", "server/utils/a.test.ts", "server/__mocks__/x.ts"];
  const neighbours = ["plugins/a.ts", "plugins/b.ts", "plugins/c.ts", "plugins/d.ts"];
  const imports = [
    ...neighbours.map(from => ({ from, to: "server/test/factories.ts" })), ...neighbours.slice(0, 3).map(from => ({ from, to: "server/__mocks__/x.ts" })),
    ...neighbours.slice(0, 2).map(from => ({ from, to: "server/routes/auth.spec.ts" })), { from: "plugins/a.ts", to: "server/utils/a.test.ts" },
    { from: "plugins/a.ts", to: "server/main.ts" }, { from: "plugins/a.ts", to: "server/env.ts" }, { from: "plugins/b.ts", to: "server/env.ts" },
  ];
  expect(relevantFiles({ files, neighbours, imports })).toEqual(
    ["server/env.ts", "server/main.ts", "server/test/factories.ts", "server/__mocks__/x.ts", "server/routes/auth.spec.ts", "server/utils/a.test.ts"]);
});

/** A viewer opened with `show` beside `cat`, which stands in for the agent: whatever the viewer types into its pane, `cat` echoes back. */
const beside = async (name: string, prepare?: (directory: string) => Promise<void>, show: string[] = []) => {
  const directory = await mkdtemp(join(tmpdir(), `pathlight-${name}-`));
  const socket = join("/tmp", `c4${name.slice(0, 3)}-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  await cp("tests/fixtures/viewer", directory, { recursive: true });
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
  await prepare?.(directory);
  const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "280", "-y", "44", "-P", "-F", "#{pane_id}", "cat");
  const shown = JSON.parse(await run(process.execPath, [resolve("src/cli.ts"), "show", "live", "--workspace", directory, "--project", "viewer", "--pane", harness, "--socket", socket, ...show])) as { pane: string };
  const until = async (pane: string, predicate: (text: string) => boolean, label: string) => {
    let output = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      output = await tmux("capture-pane", "-p", "-J", "-t", pane);
      if (predicate(output)) return output;
      await delay(50);
    }
    throw new Error(`Missing ${label}:\n${output}`);
  };
  // `cat` shows what it was sent twice (the terminal's echo and its own output); a request has arrived when it is there twice.
  const arrived = (text: string) => until(harness, output => output.replace(/\n/g, "").split(text).length > 2, `"${text.slice(0, 40)}" echoed back`);
  // One key at a time: Esc followed at once by a letter reads as Alt and that letter.
  const keys = async (...keys: string[]) => { for (const key of keys) { await tmux("send-keys", "-t", shown.pane, key); await delay(60); } };
  const type = (text: string) => tmux("send-keys", "-t", shown.pane, "-l", text);
  const close = async () => { await tmux("kill-server").catch(() => undefined); await rm(directory, { recursive: true, force: true }); };
  await until(shown.pane, text => text.includes("Selected: plugin"), "viewer");
  await delay(700);
  return { directory, harness, pane: shown.pane, tmux, until, arrived, keys, type, close };
};

test("t opens the talk in the column: the first Enter sends ask.ts's message unchanged, later ones the typed text alone, and the keys go back to the diagram", async () => {
  const at = await beside("talk");
  try {
    // On first open t offers the first question about the box the view opens on, with draw it on, so the first ask is one Enter.
    await at.keys("t");
    const opened = await at.until(at.pane, text => text.includes("Talk · Agent adapters") && text.includes("how does Agent adapters work?") && text.includes("● draw it"), "the talk with the first question offered");
    expect(opened).toContain("▎Ask");
    expect(opened).not.toContain("Ask the agent");
    await at.keys("Enter");
    // Byte for byte what src/ask.ts builds: the files a request names are none here (the fixture maps no source), its connections are the view's.
    const first = askMessage({ title: "Agent adapters", id: "plugin", files: [], links: ["→ Activity metadata", "→ tmux launcher"], activity: [] }, "how does Agent adapters work?", true);
    await at.arrived(first);
    const sent = await at.until(at.pane, text => text.includes("✓ Asked the agent about Agent adapters"), "asked toast");
    // After a send the talk stays showing, its tabs gone, the keys on the diagram.
    expect(sent).toContain("Talk · Agent adapters");
    expect(sent).not.toContain("▎Ask");
    expect(sent).toContain("diagram");
    // t focuses the field again (same subject, no tabs); an empty field sends nothing.
    await at.keys("t");
    await at.until(at.pane, text => text.includes(" talk ") && text.includes("enter send"), "the field focused");
    await at.keys("Enter");
    await delay(300);
    expect(await at.tmux("capture-pane", "-p", "-t", at.pane)).toContain("enter send");
    // A later message is the typed text alone; Alt+Enter adds a line in the field rather than sending.
    await at.type("yes, record it");
    await at.keys("M-Enter");
    await at.type("as a journey");
    await delay(300);
    expect((await at.tmux("capture-pane", "-p", "-t", at.harness)).split("yes, record it").length).toBe(1);
    await at.keys("Enter");
    await at.until(at.harness, text => text.includes("as a journey"), "the reply echoed back");
    const echoed = (await at.tmux("capture-pane", "-p", "-t", at.harness)).replace(/\n/g, "").split(first.slice(-40)).at(-1)!;
    expect(echoed).toContain("yes, record it");
    expect(echoed).not.toContain("About the");
    // m after a send begins a new talk, with its tabs again, on the map tab (dim here: the fixture is no draft).
    await at.keys("Escape", "m");
    await at.until(at.pane, text => text.includes("▎Improve the map") && text.includes("needs a map drawn by pathlight draft"), "a new talk on the map tab");
    // Tab moves between the kinds of request and keeps the typed text.
    await at.type("what is it");
    await at.keys("Tab");
    await at.until(at.pane, text => text.includes("▎Trace a flow") && text.includes("what is it"), "the trace tab, the text kept");
    await at.keys("Tab");
    await at.until(at.pane, text => text.includes("▎Ask") && text.includes("● connections 2"), "back to the question tab");
    // Up from the field's first row reaches the toggles: connections off, so the request carries none.
    await at.keys("BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace");
    await at.type("why does this exist?");
    await at.keys("Up", "Right", "Space");
    await at.until(at.pane, text => text.includes("○ connections 2") && text.includes("← → choose"), "connections off");
    await at.keys("Down", "Enter");
    await at.arrived(askMessage({ title: "Agent adapters", id: "plugin", files: [], links: [], activity: [] }, "why does this exist?", false));
  } finally { await at.close(); }
}, 60_000);

test("Esc steps back: the field, then the talk, and the node face returns with the diagram exactly where it was; i flips faces and keeps the talk", async () => {
  const at = await beside("faces");
  try {
    const before = await at.tmux("capture-pane", "-p", "-t", at.pane);
    await at.keys("t");
    await at.until(at.pane, text => text.includes("Talk · Agent adapters"), "the talk");
    // `i` flips to the node face and back without closing the talk (the field has the keys first, so Esc hands them to the diagram).
    await at.keys("Escape", "i");
    await at.until(at.pane, text => !text.includes("Talk · Agent adapters") && text.includes("Connects"), "the node face");
    await at.keys("i");
    await at.until(at.pane, text => text.includes("Talk · Agent adapters") && text.includes("▎Ask"), "the talk again, still fresh");
    // Selecting another box flips nothing: the talk's header names it as the subject of the next request.
    await at.keys("l");
    await at.until(at.pane, text => text.includes("Talk · Activity metadata") || text.includes("Talk · tmux launcher"), "the new subject");
    await at.keys("h");
    await at.until(at.pane, text => text.includes("Talk · Agent adapters"), "back on the first box");
    // z widens it, and Esc narrows it before it closes the talk.
    await at.keys("z");
    await at.until(at.pane, text => text.includes("z narrower"), "the wide talk");
    await at.keys("Escape");
    await at.until(at.pane, text => text.includes("z wider"), "narrow again");
    await at.keys("Escape");
    await at.until(at.pane, text => !text.includes("Talk ·"), "the talk closed");
    await delay(600);
    // Everything is where it was; only the question line changed, since choosing a box yourself ends the offer of the first question.
    const asked = (screen: string) => screen.replace(/› (how does Agent adapters work\?|ask about Agent adapters…) +t/, "› QUESTION t");
    expect(asked(await at.tmux("capture-pane", "-p", "-t", at.pane))).toBe(asked(before));
  } finally { await at.close(); }
}, 60_000);

test("a line the host appends to the conversation file shows in the talk within one poll, and nothing of it is written by pathlight", async () => {
  let transcript = "";
  const at = await beside("reply", async directory => {
    transcript = join(directory, "conversation.jsonl");
    await writeFile(transcript, await readFile("tests/fixtures/conversation/claude.jsonl", "utf8"));
    await mkdir(join(directory, ".cache", "pathlight", "sessions"), { recursive: true });
    await writeFile(join(directory, ".cache", "pathlight", "sessions", "claude-host.json"), JSON.stringify({ version: 1, source: "claude", session: "host", transcript, waiting: false, ended: Date.now() }));
  }, ["--session", "host", "--source", "claude"]);
  try {
    await at.keys("t");
    await at.until(at.pane, text => text.includes("Cancelling releases the courier first"), "the fixture's conversation");
    await at.keys("Escape");
    await appendFile(transcript, `${JSON.stringify({ type: "assistant", uuid: "late", timestamp: new Date().toISOString(), message: { id: "msg_late", role: "assistant", content: [{ type: "text", text: "Recorded it as a journey." }] } })}\n`);
    const shown = await at.until(at.pane, text => text.includes("Recorded it as a journey."), "the appended reply");
    expect(shown).toContain("Talk · Agent adapters");
    // On the node face a reply only says so, in one word.
    await at.keys("i");
    await at.until(at.pane, text => text.includes("Connects"), "the node face");
    await appendFile(transcript, `${JSON.stringify({ type: "assistant", uuid: "later", timestamp: new Date().toISOString(), message: { id: "msg_later", role: "assistant", content: [{ type: "text", text: "Done." }] } })}\n`);
    await at.until(at.pane, text => /Agent adapters\s+replied/.test(text), "replied");
    const written = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(at.directory, ".cache"), dot: true }));
    for (const path of written) expect(await readFile(join(at.directory, ".cache", path), "utf8"), path).not.toContain("Recorded it as a journey");
  } finally { await at.close(); }
}, 60_000);

test("d opens the talk on the trace tab: the request names the skill, the command and the component's files, and nothing is sent until Enter", async () => {
  const at = await beside("flow");
  try {
    await at.keys("d");
    await at.until(at.pane, text => text.includes("▎Trace a flow") && text.includes("it reads the code, then records a journey"), "the trace tab");
    await at.keys("Enter");
    await delay(300);
    expect(await at.tmux("capture-pane", "-p", "-t", at.harness)).not.toContain("pathlight journey");
    await at.type("how an adapter records a call");
    await at.keys("Enter");
    const typed = (await at.until(at.harness, text => text.replace(/\n/g, "").includes("Do not change product code."), "request echoed back")).replace(/\n/g, "");
    expect(typed).toContain('Trace how this works in the "Agent adapters" component (plugin) and record it as a pathlight journey: how an adapter records a call');
    expect(typed).toContain("pathlight flow add");
    expect(typed).not.toContain("tracer");
    expect(typed).toContain("pathlight-behavior skill");
    await at.until(at.pane, text => text.includes("Asked the agent to trace a flow"), "toast");
  } finally { await at.close(); }
}, 60_000);

test("a flow request is one clean line that keeps the rules: confirm each hop in a file, name the files, change no product code", () => {
  const text = flowMessage({ title: "Orders\x1b[31m", id: "parcel.orders", files: ["src/orders.ts"], links: ["→ Stock"] }, "what\nhappens?");
  expect(text).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(text).toContain('"Orders [31m" component (parcel.orders)');
  expect(text).toContain("what happens? [files: src/orders.ts; connects: → Stock]");
  expect(text).toMatch(/confirm each hop in a file.*pathlight flow add.*Do not change product code\.$/);
});
