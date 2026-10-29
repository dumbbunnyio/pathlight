import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { askMessage, flowMessage, mapMessage } from "../src/ask";
import { createConversationReader, conversationCap, foldRequest, parseClaudeLines, parseOpenCodeRows, tailConversation } from "../src/conversation";

const fixture = "tests/fixtures/conversation/claude.jsonl";
const lines = async () => (await readFile(fixture, "utf8")).split("\n").filter(Boolean);

test("the conversation is the prompts the person typed and the agent's text, in order, each with its time; nothing else the host keeps", async () => {
  const messages = parseClaudeLines(await lines());
  expect(messages.map(message => [message.role, message.text.split("\n")[0]])).toEqual([
    ["you", "Where are the order totals computed?"],
    ["agent", "Totals are computed in one place."],
    ["agent", "## Where"],
    ["you", "what happens when an order is cancelled?"],
    ["agent", "Cancelling releases the courier first, then closes the order. Want me to record this as a journey?"],
  ]);
  expect(messages[0]!.at).toBe(Date.parse("2026-10-29T12:04:05.100Z"));
  const all = messages.map(message => message.text).join("\n");
  // Skipped: the request body, thinking, the tool call and its result, the system line, the slash command, the task notice, the subagent's turns.
  for (const absent of ["request body", "private reasoning", "file contents", "src/orders/total.ts", "/clear", "task-notification", "subagent"]) expect(all).not.toContain(absent);
});

test("the text blocks of one message are merged in apiBlockIndex order, whatever order their lines arrive in", () => {
  const block = (index: number, text: string) => JSON.stringify({ type: "assistant", uuid: `u${index}`, timestamp: "2026-10-29T12:00:00Z", apiBlockIndex: index,
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text }] } });
  expect(parseClaudeLines([block(2, "third"), block(0, "first"), block(1, "second")]).map(message => message.text)).toEqual(["first\n\nsecond\n\nthird"]);
});

test("a request the viewer typed shows as the question alone: the context block and the rules are folded away, byte for byte as ask.ts builds them", () => {
  const target = { title: 'Orders "v2" (old)', id: "shop.orders", files: ["src/a.ts"], links: ["→ Couriers"], activity: ["read src/a.ts"] };
  expect(foldRequest(askMessage(target, "what happens when it is cancelled?", true))).toBe("what happens when it is cancelled?");
  expect(foldRequest(askMessage({ ...target, files: [], links: [], activity: [] }, "why is it slow?"))).toBe("why is it slow?");
  expect(foldRequest(mapMessage({ ...target, key: "src/orders" }, "call it Orders"))).toBe("call it Orders");
  expect(foldRequest(flowMessage(target, "how a refund moves"))).toBe("how a refund moves");
  expect(foldRequest(flowMessage({ ...target, files: [], links: [] }, "how a refund moves"))).toBe("how a refund moves");
  expect(foldRequest("About the weather: it is fine")).toBe("About the weather: it is fine");
});

test("tailing reads only what was appended, waits for a line being written, and starts again when the file was replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-tail-"));
  try {
    const path = join(directory, "t.jsonl");
    await writeFile(path, "one\ntwo\nthr");
    const first = await Effect.runPromise(tailConversation(path, undefined));
    expect(first).toEqual({ lines: ["one", "two"], offset: 8, reset: false });
    expect(await Effect.runPromise(tailConversation(path, first.offset))).toEqual({ lines: [], offset: 8, reset: false });
    await appendFile(path, "ee\nfour\n");
    expect(await Effect.runPromise(tailConversation(path, first.offset))).toEqual({ lines: ["three", "four"], offset: 19, reset: false });
    await writeFile(path, "new\n");
    expect(await Effect.runPromise(tailConversation(path, 19))).toEqual({ lines: ["new"], offset: 4, reset: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a reader polls the file the pointer names: a line appended shows on the next poll, a replaced file is read afresh, and only the newest 200 are kept", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-reader-"));
  try {
    const path = join(directory, "t.jsonl");
    await copyFile(fixture, path);
    const reader = createConversationReader({ source: "claude", session: "s", transcript: path });
    expect(await Effect.runPromise(reader.poll())).toHaveLength(5);
    const line = (index: number) => `${JSON.stringify({ type: "assistant", uuid: `n${index}`, timestamp: "2026-10-29T13:00:00Z", message: { id: `m${index}`, role: "assistant", content: [{ type: "text", text: `reply ${index}` }] } })}\n`;
    await appendFile(path, line(0));
    expect((await Effect.runPromise(reader.poll())).at(-1)!.text).toBe("reply 0");
    await appendFile(path, Array.from({ length: 300 }, (_, index) => line(index + 1)).join(""));
    const many = await Effect.runPromise(reader.poll());
    expect(many).toHaveLength(conversationCap);
    expect(many.at(-1)!.text).toBe("reply 300");
    await writeFile(path, line(999));
    expect((await Effect.runPromise(reader.poll())).map(message => message.text)).toEqual(["reply 999"]);
    await expect(Effect.runPromise(createConversationReader({ source: "claude", session: "s", transcript: join(directory, "gone.jsonl") }).poll())).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenCode's rows give the same messages: typed text, the agent's text parts, a streamed row rewritten in place, and nothing synthetic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-opencode-db-"));
  try {
    const path = join(directory, "opencode.db");
    const database = new Database(path);
    database.run("create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null)");
    const insert = (id: string, session: string, type: string, seq: number, data: unknown) => database.run("insert or replace into session_message values (?, ?, ?, ?, 0, 0, ?)", [id, session, type, seq, JSON.stringify(data)]);
    insert("m1", "ses_a", "user", 1, { time: { created: 1000 }, text: askMessage({ title: "Orders", id: "shop.orders", files: [], links: [] }, "where do totals come from?"), files: [], agents: [] });
    insert("m2", "ses_a", "assistant", 2, { time: { created: 2000 }, content: [{ type: "tool", name: "read" }, { type: "text", text: "In total.ts" }] });
    insert("m3", "ses_a", "synthetic", 3, { time: { created: 3000 }, text: "The previous response was interrupted." });
    insert("x1", "ses_b", "user", 1, { time: { created: 1000 }, text: "another session" });
    expect(parseOpenCodeRows([{ id: "bad", type: "user", data: "{" }])).toEqual([]);
    const reader = createConversationReader({ source: "opencode", session: "ses_a", transcript: path });
    expect(await Effect.runPromise(reader.poll())).toEqual([{ id: "m1", role: "you", at: 1000, text: "where do totals come from?" }, { id: "m2", role: "agent", at: 2000, text: "In total.ts" }]);
    insert("m4", "ses_a", "assistant", 4, { time: { created: 4000 }, content: [{ type: "text", text: "Streaming" }] });
    expect((await Effect.runPromise(reader.poll())).at(-1)).toEqual({ id: "m4", role: "agent", at: 4000, text: "Streaming" });
    insert("m4", "ses_a", "assistant", 4, { time: { created: 4000 }, content: [{ type: "text", text: "Streaming, now complete." }] });
    const after = await Effect.runPromise(reader.poll());
    expect(after.map(message => message.text)).toEqual(["where do totals come from?", "In total.ts", "Streaming, now complete."]);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
