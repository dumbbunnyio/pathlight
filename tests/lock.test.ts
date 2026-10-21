import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { acquireLock } from "../src/tmux";

test("the viewer lock refuses a second holder, frees on release, and replaces one left by a dead process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-lock-"));
  const path = join(directory, "a.lock");
  try {
    const scoped = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));
    // Held: a second request fails with the retry message, then succeeds once the first has finished.
    await scoped(Effect.gen(function* () {
      yield* acquireLock(path);
      expect((yield* Effect.promise(() => readFile(path, "utf8"))).trim()).toBe(String(process.pid));
      const second = yield* Effect.scoped(acquireLock(path)).pipe(Effect.flip);
      expect(second.message).toContain("Another diagram request is in progress");
    }));
    await scoped(acquireLock(path));
    // A lock file naming a process that is gone is taken over.
    await writeFile(path, "999999999\n");
    await scoped(acquireLock(path));
    await expect(readFile(path, "utf8")).rejects.toBeDefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
