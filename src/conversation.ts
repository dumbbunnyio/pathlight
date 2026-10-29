import { Database } from "bun:sqlite";
import { open, stat } from "node:fs/promises";
import { Effect } from "effect";
import { io } from "./effects";
import type { SessionPointer } from "./sessions";

/**
 * One turn of the conversation as the host wrote it: what the person typed, or the agent's text. Nothing else the host keeps (tool calls, their
 * results, thinking, a subagent's turns, slash commands, notices it injects) is a message. Read from the host's own file while the talk is showing,
 * held in memory and never written anywhere.
 */
export interface Message { role: "you" | "agent"; text: string; at: number; id: string }

/** The talk keeps the newest messages only. */
export const conversationCap = 200;

// A request the viewer typed (src/ask.ts): the question follows its opening, and the context block and the rules after it are folded away.
const request = /^(?:About the ".*?" component \([^()]*\): |Improve the pathlight map for the ".*?" component \([^()]*\): |Trace how this works in the ".*?" component \([^()]*\) and record it as a pathlight journey: )/;
const requestTail = [" [files: ", " [connects: ", " [recent: ", " [overlay key: ", " Load the pathlight skill", " If this asks you to change the code", " Read the files, answer me here", " Follow the pathlight-behavior skill"];

/** A prompt the viewer sent shows as the question that was typed; any other prompt shows as it is. */
export const foldRequest = (text: string) => {
  const head = request.exec(text);
  if (!head) return text;
  const rest = text.slice(head[0].length), ends = requestTail.map(marker => rest.indexOf(marker)).filter(index => index >= 0);
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
};

// Prompts the person did not type: slash commands and their output, background-task notices, shell escapes. They arrive as user lines without `isMeta`.
const notTyped = /^<(command-name|command-message|local-command-|task-notification|bash-)/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Claude Code's transcript (JSON Lines, undocumented, so read tolerantly): a typed prompt is a `user` line whose content is text and whose origin is
 * the person; the agent's text is the `text` blocks of `assistant` lines, one block per line, merged per `message.id` in `apiBlockIndex` order.
 * Request bodies (`api-request-blob`), bookkeeping, tool results, thinking, `isMeta` and `isSidechain` lines are skipped.
 */
export const createClaudeParser = () => {
  const drafts = new Map<string, { role: Message["role"]; at: number; blocks: Map<number, string> }>();
  const add = (line: string) => {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return; }
    if (!isRecord(entry) || entry.isSidechain === true || entry.isMeta === true || !isRecord(entry.message)) return;
    const at = Date.parse(String(entry.timestamp ?? "")) || 0, content = entry.message.content;
    if (entry.type === "user") {
      const origin = isRecord(entry.origin) ? entry.origin.kind : undefined;
      if (origin !== undefined && origin !== "human") return;
      const text = typeof content === "string" ? content : Array.isArray(content) && content.every(block => isRecord(block) && block.type !== "tool_result")
        ? content.flatMap(block => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : undefined;
      if (!text?.trim() || notTyped.test(text.trimStart())) return;
      drafts.set(String(entry.uuid ?? `you-${drafts.size}`), { role: "you", at, blocks: new Map([[0, foldRequest(text)]]) });
      return;
    }
    if (entry.type !== "assistant" || !Array.isArray(content)) return;
    const id = String(entry.message.id ?? entry.uuid ?? `agent-${drafts.size}`), index = typeof entry.apiBlockIndex === "number" ? entry.apiBlockIndex : undefined;
    content.forEach((block, offset) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) return;
      const draft = drafts.get(id) ?? { role: "agent" as const, at, blocks: new Map<number, string>() };
      draft.blocks.set(index ?? draft.blocks.size + offset, block.text);
      drafts.set(id, draft);
    });
  };
  return {
    add(lines: readonly string[]) { for (const line of lines) if (line.trim()) add(line); },
    messages(): Message[] {
      const all = [...drafts].map(([id, draft]) => ({ id, role: draft.role, at: draft.at, text: [...draft.blocks].sort((a, b) => a[0] - b[0]).map(([, text]) => text.trim()).join("\n\n") }));
      // The oldest are let go so a long session costs no more than the last few hundred messages.
      for (const [id] of [...drafts].slice(0, Math.max(0, drafts.size - conversationCap))) drafts.delete(id);
      return all.slice(-conversationCap);
    },
  };
};

/** The messages of a run of transcript lines, in order. */
export const parseClaudeLines = (lines: readonly string[]) => { const parser = createClaudeParser(); parser.add(lines); return parser.messages(); };

/** The first read of a long transcript starts this far from its end: it holds far more than the newest 200 messages. */
const firstRead = 8 * 1024 * 1024;

/**
 * The lines appended to a file since `offset`, and where the next read starts. A line still being written waits for the next read; a file shorter
 * than the offset was replaced, and is read again from its start (`reset`). The first read (`offset` undefined) starts near the end of a long file.
 */
export const tailConversation = Effect.fn("Conversation.tail")(function* (path: string, offset: number | undefined) {
  const size = (yield* io("Conversation.stat", () => stat(path))).size;
  const reset = offset !== undefined && size < offset;
  const from = offset === undefined || reset ? Math.max(0, size - firstRead) : offset;
  if (from >= size) return { lines: [] as string[], offset: from, reset };
  const bytes = yield* io("Conversation.read", async () => {
    const handle = await open(path, "r");
    try { const buffer = Buffer.alloc(size - from); await handle.read(buffer, 0, buffer.length, from); return buffer; } finally { await handle.close(); }
  });
  const end = bytes.lastIndexOf(10);
  if (end < 0) return { lines: [] as string[], offset: from, reset };
  // A read that starts inside the file (not at a line it wrote last) skips the partial line it lands in.
  const start = from > 0 && from !== offset ? bytes.indexOf(10) + 1 : 0;
  return { lines: bytes.subarray(start, end).toString("utf8").split("\n"), offset: from + end + 1, reset };
});

/**
 * OpenCode keeps a session in its own database (`session_message`): a `user` row's text is what was typed, an `assistant` row's text parts are the
 * agent's (tool parts are not), and an `assistant` row is rewritten while it streams. Rows are read from the last one seen, that one included.
 */
export const readOpenCodeRows = (path: string, session: string, from: number) => Effect.try({
  try: () => {
    const database = new Database(path, { readonly: true });
    try {
      return database.query<{ id: string; seq: number; type: string; data: string }, [string, number]>(
        "select id, seq, type, data from session_message where session_id = ? and seq >= ? and type in ('user', 'assistant') order by seq limit 2000").all(session, from);
    } finally { database.close(); }
  },
  catch: cause => cause,
});

/** The messages in OpenCode's rows. */
export const parseOpenCodeRows = (rows: readonly { id: string; type: string; data: string }[]): Message[] => rows.flatMap((row): Message[] => {
  let data: unknown;
  try { data = JSON.parse(row.data); } catch { return []; }
  if (!isRecord(data)) return [];
  const at = isRecord(data.time) && typeof data.time.created === "number" ? data.time.created : 0;
  if (row.type === "user" && typeof data.text === "string" && data.text.trim()) return [{ id: row.id, role: "you", at, text: foldRequest(data.text) }];
  const text = row.type === "assistant" && Array.isArray(data.content)
    ? data.content.flatMap(part => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim() ? [part.text.trim()] : []).join("\n\n") : "";
  return text ? [{ id: row.id, role: "agent", at, text }] : [];
});

/**
 * A session's conversation as it grows, read from the host's file the pointer names: each `poll` reads what is new and returns the whole bounded
 * list. One reader per host behind one `Message` type.
 */
export const createConversationReader = (pointer: Pick<SessionPointer, "source" | "session" | "transcript">) => {
  if (pointer.source === "opencode") {
    const messages = new Map<string, Message>();
    let seq = 0;
    return {
      poll: Effect.fn("Conversation.pollOpenCode")(function* () {
        if (!pointer.transcript) return [] as Message[];
        const rows = yield* readOpenCodeRows(pointer.transcript, pointer.session, seq);
        for (const message of parseOpenCodeRows(rows)) { messages.delete(message.id); messages.set(message.id, message); }
        seq = Math.max(seq, ...rows.map(row => row.seq));
        for (const [id] of [...messages].slice(0, Math.max(0, messages.size - conversationCap))) messages.delete(id);
        return [...messages.values()];
      }),
    };
  }
  let parser = createClaudeParser(), offset: number | undefined;
  return {
    poll: Effect.fn("Conversation.pollClaude")(function* () {
      if (!pointer.transcript) return [] as Message[];
      const read = yield* tailConversation(pointer.transcript, offset);
      if (read.reset) parser = createClaudeParser();
      offset = read.offset;
      parser.add(read.lines);
      return parser.messages();
    }),
  };
};
