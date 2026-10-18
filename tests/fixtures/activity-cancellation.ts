import { mock } from "bun:test";
import { Effect, Fiber } from "effect";
import * as fs from "node:fs/promises";

const writeFile = fs.writeFile;
const unlink = fs.unlink;
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const operations: string[] = [];
mock.module("node:fs/promises", () => ({
  ...fs,
  writeFile: async (...args: Parameters<typeof writeFile>) => {
    entered.resolve();
    await release.promise;
    await writeFile(...args);
    operations.push("written");
  },
  unlink: async (...args: Parameters<typeof unlink>) => {
    operations.push("cleanup");
    return unlink(...args);
  },
}));

const { toolActivity, writeActivity, activityDirectory } = await import("../../src/activity");
const workspace = process.argv[2];
if (!workspace) throw new Error("Missing test workspace");
const event = Effect.runSync(toolActivity(workspace, { source: "opencode", session: "cancel" }, "call", "read", {}, "completed"));
const fiber = Effect.runFork(writeActivity(workspace, event));
await entered.promise;
const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
await Effect.runPromise(Effect.yieldNow);
release.resolve();
await interrupted;
const directory = await Effect.runPromise(activityDirectory(workspace, event));
process.stdout.write(JSON.stringify({ operations, temporary: (await fs.readdir(directory)).filter(file => file.endsWith(".tmp")) }));
