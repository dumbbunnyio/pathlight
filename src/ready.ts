import { rename, writeFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { io } from "./effects";

export const Ready = Schema.Union([Schema.Struct({ protocol: Schema.String }), Schema.Struct({ error: Schema.String })]);

export const writeReady = Effect.fn("Ready.write")(function* (path: string, status: typeof Ready.Type) {
  yield* io("Ready.writeTemporary", () => writeFile(`${path}.tmp`, JSON.stringify(status)));
  yield* io("Ready.publish", () => rename(`${path}.tmp`, path));
}, Effect.uninterruptible);
