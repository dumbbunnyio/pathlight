import { Effect } from "effect";
import * as Activity from "../src/activity";
import * as Claude from "../src/claude";
import * as Process from "../src/process";
import * as Catalog from "../src/catalog";
import * as Files from "../src/node-files";

export const run = (...args: Parameters<typeof Process.run>) => Effect.runPromise(Process.run(...args));
export const selectView = (...args: Parameters<typeof Catalog.selectView>) => Effect.runPromise(Catalog.selectView(...args));
export const nodeFiles = (...args: Parameters<typeof Files.nodeFiles>) => Effect.runPromise(Files.nodeFiles(...args));
export const editorFile = (...args: Parameters<typeof Files.editorFile>) => Effect.runPromise(Files.editorFile(...args));

export const activityDirectory = (...args: Parameters<typeof Activity.activityDirectory>) => Effect.runPromise(Activity.activityDirectory(...args));
export const readActivity = (...args: Parameters<typeof Activity.readActivity>) => Effect.runPromise(Activity.readActivity(...args));
export const writeActivity = (...args: Parameters<typeof Activity.writeActivity>) => Effect.runPromise(Activity.writeActivity(...args));
export const toolActivity = (...args: Parameters<typeof Activity.toolActivity>) => Effect.runSync(Activity.toolActivity(...args));
export const claudeActivity = (...args: Parameters<typeof Claude.claudeActivity>) => Effect.runPromise(Claude.claudeActivity(...args));
