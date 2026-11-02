import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { askMessage, mapMessage } from "../src/ask";
import { frameText } from "../src/pane";
import { keyAction, type KeyMode, type KeyPress } from "../src/viewer/keys";
import { mappingIn, run } from "./effects";

/**
 * `pathlight pane` is the viewer drawn for a host's own window: frames on standard output, keys over a Unix socket. These start the real command on
 * the frozen fixture and drive it the way the Claude Code plugin does.
 */
type Frame = { cols: number; rows: number; text: string };
const start = async (workspace: string, cols: number, rows: number, extra: string[] = []) => {
  const config = await mkdtemp(join(tmpdir(), "pathlight-pane-config-"));
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "pane", "live", "--workspace", workspace, "--project", "viewer", "--cols", String(cols), "--rows", String(rows), ...extra],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_CONFIG_HOME: config, COLORTERM: "truecolor" } });
  const state = { frame: undefined as Frame | undefined, frames: 0, at: 0, socket: "", ready: false, asks: [] as { id: number; text: string }[], empty: 0 };
  const reader = child.stdout.getReader();
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      buffer += decoder.decode(next.value, { stream: true });
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith("frame ")) {
          const [, c, r, cells] = line.split(" ");
          state.frame = { cols: Number(c), rows: Number(r), text: frameText(Number(c), Number(r), cells!) };
          state.frames++; state.at = Date.now();
        } else if (line.startsWith("socket ")) state.socket = line.slice(7);
        else if (line === "ready") state.ready = true;
        else if (line.startsWith("ask ")) state.asks.push(JSON.parse(line.slice(4)));
        else if (line === "") state.empty++;
      }
    }
  })().catch(() => undefined);
  const until = async <T>(read: () => T | undefined | false, label: string, ms = 20_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Missing ${label}:\n${state.frame?.text ?? "(no frame)"}`);
      await delay(40);
    }
  };
  // The picture has settled when no frame has come for half a second (the first view blooms in for a moment after it is ready).
  const settled = async () => { await until(() => state.ready, "ready"); await until(() => Date.now() - state.at > 500 && state.frame, "a settled frame"); return state.frame!; };
  const post = (path: string, body: unknown) => fetch(`http://pane${path}`, { method: "POST", body: JSON.stringify(body), unix: state.socket } as RequestInit);
  const key = async (...keys: string[]) => { for (const name of keys) { expect((await post("/key", { key: name })).status).toBe(204); await delay(60); } };
  const stop = async () => { child.kill(); await child.exited; await rm(config, { recursive: true, force: true }); };
  return { child, state, until, settled, post, key, stop, closeOutput: () => reader.cancel() };
};

// Rows as tmux captures them: trailing blanks off each row and blank rows off the end, so the two sources compare on what is drawn.
const rows = (text: string) => text.split("\n").map(row => row.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");

test("the pane's first frame is the screen pathlight see shows for the same view and size", async () => {
  const pane = await start("tests/fixtures/viewer", 120, 36);
  try {
    const frame = await pane.settled();
    expect([frame.cols, frame.rows]).toEqual([120, 36]);
    const out = join(tmpdir(), `pathlight-pane-see-${process.pid}.txt`);
    await run("sh", ["-c", `"$1" "$2" see live --workspace tests/fixtures/viewer --project viewer --cols 120 --rows 36 > "$3"`, "sh", process.execPath, resolve("src/cli.ts"), out]);
    expect(rows(frame.text)).toBe(rows(await readFile(out, "utf8")));
    await rm(out, { force: true });
  } finally { await pane.stop(); }
}, 60_000);

test("a key moves the selection, a resize redraws at the new size, and q never quits the pane", async () => {
  const pane = await start("tests/fixtures/viewer", 120, 36);
  try {
    const first = await pane.settled();
    expect(first.text).toContain("Selected: plugin");
    await pane.key("l");
    const moved = await pane.until(() => pane.state.frame && !pane.state.frame.text.includes("Selected: plugin") && pane.state.frame, "the selection moved");
    expect(moved.text).toMatch(/Selected: \w+/);
    expect((await pane.post("/resize", { cols: 100, rows: 30 })).status).toBe(204);
    const resized = await pane.until(() => pane.state.frame?.cols === 100 && pane.state.frame.rows === 30 && pane.state.frame, "a 100 × 30 frame");
    expect(resized.text.split("\n")).toHaveLength(30);
    // q is the pane's Esc: with nothing open it leaves nothing, and the process stays.
    await pane.key("q");
    await delay(400);
    expect(pane.child.exitCode).toBeNull();
    // Nonsense is refused without a word on the screen.
    expect((await pane.post("/resize", { cols: 5, rows: 2 })).status).toBe(400);
    expect((await pane.post("/key", { key: 42 })).status).toBe(400);
    expect((await pane.post("/nowhere", {})).status).toBe(404);
  } finally { await pane.stop(); }
}, 60_000);

test("t and Enter hand the request up as an ask line, byte for byte what show types, and the host's answer is the talk's line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-pane-ask-"));
  await cp("tests/fixtures/viewer", directory, { recursive: true });
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
  const pane = await start(directory, 140, 36, ["--session", "pane-test", "--source", "claude"]);
  try {
    await pane.settled();
    await pane.key("t");
    await pane.until(() => pane.state.frame?.text.includes("how does Agent adapters work?"), "the talk with the first question offered");
    await pane.key("right", "return");
    const ask = await pane.until(() => pane.state.asks[0], "an ask line");
    // The same text tests/ask.test.ts sees typed into the agent's pane by show.
    expect(ask.text).toBe(askMessage({ title: "Agent adapters", id: "plugin", files: [], links: ["→ Activity metadata", "→ tmux launcher"] }, "how does Agent adapters work?", true));
    expect((await pane.post("/sent", { id: ask.id, ok: true })).status).toBe(204);
    await pane.until(() => pane.state.frame?.text.includes("Asked claude:pane-tes"), "the asked line");
    // A later request is the typed text alone; q typed in the field is a letter, and the host's Esc (blur) leaves the field.
    await pane.key("t", "q", "?");
    await pane.until(() => pane.state.frame?.text.includes("q?"), "the typed q");
    await pane.key("blur");
    await pane.until(() => pane.state.frame?.text.includes("t reply"), "the field left");
    await pane.key("t", "return");
    const second = await pane.until(() => pane.state.asks[1], "the second ask");
    expect(second.text).toBe("q?");
    // A refusal is said in the talk's words.
    await pane.post("/sent", { id: second.id, ok: false, said: "The prompt was refused: a Stop hook stands" });
    await pane.until(() => pane.state.frame?.text.includes("a Stop hook stands"), "the refusal");
    // q steps back out of the talk, as Esc does outside the pane.
    await pane.key("q");
    await pane.until(() => pane.state.frame && !pane.state.frame.text.includes("Talk · Agent adapters"), "the talk closed");
  } finally { await pane.stop(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("Enter on a file says where files open instead of suspending the renderer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-pane-file-"));
  await cp("tests/fixtures/viewer", directory, { recursive: true });
  await Bun.write(join(directory, "plugins/claude.ts"), "export {};\n");
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
  const pane = await start(directory, 140, 36);
  try {
    await pane.settled();
    await pane.key("e");
    await pane.until(() => pane.state.frame?.text.includes("claude.ts"), "the files card");
    await pane.key("return");
    const said = await pane.until(() => pane.state.frame?.text.includes("Files open from the tmux viewer") && pane.state.frame, "the refusal");
    expect(said.text).not.toContain("suspension");
    expect(pane.child.exitCode).toBeNull();
  } finally { await pane.stop(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

// In the pane under 120 columns the talk is a modal: the reply is in Claude Code's transcript beside it, and a column would hide half the diagram.
test("t in a narrow pane asks in a modal, Tab changes the kind, Enter sends it as the prompt and closes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-pane-modal-"));
  await cp("tests/fixtures/viewer", directory, { recursive: true });
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
  const pane = await start(directory, 103, 44, ["--session", "pane-modal", "--source", "claude"]);
  try {
    await pane.settled();
    await pane.key("t");
    const open = await pane.until(() => pane.state.frame?.text.includes("how does Agent adapters work?") && pane.state.frame, "the modal with the first question offered");
    expect(open.text).not.toContain("Talk · Agent adapters");
    // The screen is kept as text: tests/golden/ask-modal-103x44.txt (the modal over the diagram, with the inspector below it).
    await delay(600);
    const screen = pane.state.frame!.text.split("\n").map(row => row.replace(/\s+$/, "")).join("\n") + "\n", file = "tests/golden/ask-modal-103x44.txt";
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(file, screen);
    else expect(screen).toBe(await readFile(file, "utf8"));
    await pane.key("tab");
    await pane.until(() => pane.state.frame?.text.includes("Improve the map") && pane.state.frame.text.includes("needs a map drawn by pathlight draft"), "the map kind");
    await pane.key("tab", "tab");
    // Enter on the empty field sends nothing; → takes the suggestion.
    await pane.key("return");
    await delay(300);
    expect(pane.state.asks).toHaveLength(0);
    await pane.key("right", "return");
    const ask = await pane.until(() => pane.state.asks[0], "an ask line");
    expect(ask.text).toBe(askMessage({ title: "Agent adapters", id: "plugin", files: [], links: ["→ Activity metadata", "→ tmux launcher"] }, "how does Agent adapters work?", true));
    expect((await pane.post("/sent", { id: ask.id, ok: true })).status).toBe(204);
    const sent = await pane.until(() => pane.state.frame?.text.includes("Sent as your prompt") && pane.state.frame, "the footer's line");
    expect(sent.text).not.toContain("Improve the map");
    // q closes a modal opened and left alone: it is a letter only while typing, and the host's Esc (blur) closes it.
    await pane.key("m");
    await pane.until(() => pane.state.frame?.text.includes("What should it work out"), "the map modal");
    await pane.key("blur");
    await pane.until(() => pane.state.frame && !pane.state.frame.text.includes("What should it work out"), "the modal closed");
  } finally { await pane.stop(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("the pane ends within a second of its output closing", async () => {
  const pane = await start("tests/fixtures/viewer", 80, 24);
  try {
    await pane.settled();
    await pane.closeOutput();
    const ended = await Promise.race([pane.child.exited.then(() => true), delay(1500).then(() => false)]);
    expect(ended).toBe(true);
  } finally { await pane.stop(); }
}, 60_000);

test("in pane mode q is Esc wherever no field is typing, a letter where one is, and the host's Esc leaves the field; elsewhere nothing changes", () => {
  const key = (name: string, sequence = name): KeyPress => ({ name, sequence, ctrl: false, meta: false, shift: false });
  const mode = (over: Partial<KeyMode>): KeyMode => ({ layer: "main", replay: false, fileMode: false, focusSection: undefined, flow: false, listMode: false, cards: [], vim: true, ...over });
  expect(keyAction(key("q"), mode({}))).toEqual({ type: "stop" });
  expect(keyAction(key("q"), mode({ pane: true }))).toEqual({ type: "idle" });
  expect(keyAction(key("q"), mode({ pane: true, layer: "help" }))).toEqual({ type: "helpClose" });
  expect(keyAction(key("q"), mode({ pane: true, flow: true }))).toEqual({ type: "exitFlow" });
  expect(keyAction(key("q"), mode({ pane: true, talk: { showing: true, fresh: false } }))).toEqual({ type: "talkBack" });
  expect(keyAction(key("q"), mode({ pane: true, layer: "picker" }))).toEqual({ type: "themeCancel" });
  expect(keyAction(key("q"), mode({ pane: true, layer: "summary" }))).toEqual({ type: "summaryClose" });
  expect(keyAction(key("q"), mode({ pane: true, layer: "talk", talk: { showing: true, fresh: true } }))).toBeUndefined();
  expect(keyAction(key("q"), mode({ pane: true, layer: "goto" }))).toEqual({ type: "gotoType", text: "q" });
  expect(keyAction(key("q"), mode({ pane: true, fileMode: true }))).toEqual({ type: "pass" });
  expect(keyAction(key("f12", "\x1b[24~"), mode({ pane: true, layer: "talk", talk: { showing: true, fresh: true } }))).toEqual({ type: "talkLeave" });
  expect(keyAction(key("f12", "\x1b[24~"), mode({ pane: true, layer: "goto" }))).toEqual({ type: "gotoClose" });
  expect(keyAction(key("f12", "\x1b[24~"), mode({ pane: true }))).toEqual({ type: "swallow" });
  expect(keyAction({ ...key("c"), ctrl: true }, mode({ pane: true }))).toEqual({ type: "swallow" });
  // The inspector over the diagram is a mode: q closes it in the pane, Esc in the tmux viewer; with nothing over the diagram Esc stays idle.
  expect(keyAction(key("q"), mode({ pane: true, overlay: true }))).toEqual({ type: "inspector" });
  expect(keyAction(key("escape", "\x1b"), mode({ overlay: true }))).toEqual({ type: "inspector" });
  expect(keyAction(key("escape", "\x1b"), mode({}))).toEqual({ type: "idle" });
  expect(keyAction(key("q"), mode({ pane: true, overlay: true, flow: true }))).toEqual({ type: "exitFlow" });
});

// The modal's `m` on a drafted map: Enter right after opening it still finds the box's overlay key (it is read again on Enter, as the column does).
test("m in the modal sends the map request with the box's key even when Enter comes at once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-pane-map-"));
  await cp("tests/fixtures/viewer", directory, { recursive: true });
  await mkdir(join(directory, ".cache", "pathlight"), { recursive: true });
  await writeFile(join(directory, ".cache", "pathlight", "keys.json"), JSON.stringify({ version: 1, keys: { plugin: "plugins" } }));
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [] }));
  const pane = await start(directory, 103, 44, ["--session", "pane-map", "--source", "claude"]);
  try {
    await pane.settled();
    await pane.key("m", "h", "i", "return");
    const ask = await pane.until(() => pane.state.asks[0], "an ask line");
    expect(ask.text).toBe(mapMessage({ title: "Agent adapters", id: "plugin", key: "plugins", files: [], links: ["→ Activity metadata", "→ tmux launcher"] }, "hi"));
  } finally { await pane.stop(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
