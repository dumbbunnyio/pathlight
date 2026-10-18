import { spawn } from "node:child_process";
import { Effect } from "effect";
import { attempt, hasCode, io } from "./effects";

export const run = Effect.fn("Process.run")(function* (command: string, args: string[]) {
  const execution = yield* Effect.acquireRelease(attempt("Process.spawn", () => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const state = { child, closed: false };
    const output = new Promise<string>((resolve, reject) => {
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let outBytes = 0, errBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > 4 * 1024 * 1024) reject(new Error("stdout maxBuffer length exceeded"));
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > 4 * 1024 * 1024) reject(new Error("stderr maxBuffer length exceeded"));
        else stderr.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        state.closed = true;
        if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
        else reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${Buffer.concat(stderr).toString("utf8").trim() || signal || `exit ${code}`}`));
      });
    });
    void output.catch(() => {});
    return { state, output };
  }), ({ state, output }) => Effect.gen(function* () {
    if (state.closed) return;
    const killGroup = (signal: NodeJS.Signals) => attempt("Process.killGroup", () => {
      if (state.child.pid) process.kill(-state.child.pid, signal);
    }).pipe(Effect.catchIf(error => hasCode(error, "ESRCH"), () => Effect.void));
    const closed = Effect.callback<void>(resume => {
      if (state.closed) { resume(Effect.void); return; }
      const onClose = () => resume(Effect.void);
      state.child.once("close", onClose);
      return Effect.sync(() => { state.child.off("close", onClose); });
    });
    yield* killGroup("SIGTERM");
    yield* closed.pipe(Effect.raceFirst(Effect.sleep("1 second")));
    yield* killGroup("SIGKILL");
    yield* closed;
    yield* io("Process.result", () => output).pipe(Effect.ignore);
  }).pipe(Effect.orDie));
  return yield* io(`Process.${command}`, () => execution.output);
}, Effect.scoped, Effect.timeout("120 seconds"));
