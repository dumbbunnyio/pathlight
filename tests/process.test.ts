import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../src/process";

test("cancelling a command terminates descendants that keep stdout open and ignore TERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-process-"));
  const marker = join(directory, "child");
  const fiber = Effect.runFork(run("sh", ["-c", 'trap "" TERM; sleep 60 & echo $! > "$1"; wait', "test", marker]));
  try {
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await readFile(marker, "utf8").catch(() => "0"));
      if (!pid) await delay(10);
    }
    expect(pid).toBeGreaterThan(0);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    expect(status === "" || status.split(") ")[1]?.startsWith("Z ")).toBe(true);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);
