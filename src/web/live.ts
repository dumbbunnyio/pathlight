import { Effect } from "effect";
import { type ActivityBinding, type ActivityConfig, type ActivityEvent, latestBinding, readActivity } from "../activity";
import { readSession } from "../sessions";
import { isActive } from "../viewer/activity-view";
import { elementsOf } from "../viewer/where";

/**
 * The agent's activity for the browser page (plan 4d, step 3), read as the terminal reads it: the bound session's journal (or, following, the
 * most recently active recorded session's), polled every 250 ms, with reads kept out of everything live (they show in replay and `c` only).
 * One snapshot serves every window; what a window does with it (its follow, its offer) is in session.ts. Nothing here moves a camera or a
 * selection, and nothing pulses that was not observed (contracts 3 and 4).
 */

export type Rule = ActivityConfig["mappings"][number] & { match: Bun.Glob };
export const rulesOf = (config: ActivityConfig | undefined): Rule[] => config?.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) })) ?? [];

export interface Live {
  /** A session is being shown: bound by `--session`, or the newest one found while following. */
  bound: boolean;
  /** No session was named: the newest recorded one is shown, as `pathlight open` does in a mapped workspace. */
  following: boolean;
  /** The work (edits and commands), newest first. */
  events: ActivityEvent[];
  /** Each element's work, newest first. */
  byElement: ReadonlyMap<string, ActivityEvent[]>;
  /** Elements whose card takes the accent for a moment because a call there was just seen. */
  flashes: ReadonlyMap<string, number>;
  /** The Work card's rows that flash, by call. */
  rowFlashes: ReadonlyMap<string, number>;
  /** The bound session's turn is open (its pointer's `ended` is null): only then is the newest work offered. */
  turnOpen: boolean;
  /** Changes whenever what the page shows from the journal does. */
  signature: string;
  error: string;
}

export const quiet: Live = { bound: false, following: false, events: [], byElement: new Map(), flashes: new Map(), rowFlashes: new Map(), turnOpen: false, signature: "", error: "" };

/** Whether anything shown from the journal is moving now: a running call (its spinner and pulse) or a flash that has not ended. */
export const moving = (live: Live, now = Date.now()) => live.events.some(isActive) || [...live.flashes.values(), ...live.rowFlashes.values()].some(until => until > now);

/**
 * A reader of one workspace's journal. `binding` is the session `--session` named; without one it follows the newest recorded session, and with
 * no mapping there is nothing to follow (the page then shows the model only, as the terminal does).
 */
export const createLive = (workspace: string, config: ActivityConfig | undefined, binding: ActivityBinding | undefined) => {
  const following = !binding && Boolean(config);
  const rules = rulesOf(config);
  const seen = new Set<string>(), flashes = new Map<string, number>(), rowFlashes = new Map<string, number>();
  let calm = false, current = binding, last: Live = { ...quiet, following };
  const read = Effect.gen(function* () {
    if (!binding && !following) return last;
    if (following) current = (yield* latestBinding(workspace)) ?? current;
    const all = current ? yield* readActivity(workspace, current) : [];
    const events = all.filter(event => event.operation !== "read");
    const turnOpen = current ? (yield* readSession(workspace, current))?.ended === null : false;
    // A call seen for the first time flashes its card and its Work row for a moment, but not the calls already there when the page opened.
    const now = Date.now(), until = now + 600;
    for (const event of events) {
      if (seen.has(event.call)) continue;
      seen.add(event.call);
      if (!calm) continue;
      rowFlashes.set(event.call, until);
      for (const element of elementsOf(rules, event)) flashes.set(element, until);
    }
    calm = true;
    for (const map of [flashes, rowFlashes]) for (const [key, end] of map) if (end <= now) map.delete(key);
    const byElement = new Map<string, ActivityEvent[]>();
    for (const event of events) for (const element of elementsOf(rules, event)) byElement.set(element, [...byElement.get(element) ?? [], event]);
    last = { bound: Boolean(current), following, events, byElement, flashes: new Map(flashes), rowFlashes: new Map(rowFlashes), turnOpen,
      signature: `${current?.session}/${turnOpen}/${events.map(event => `${event.call}${event.phase}`).join()}`, error: "" };
    return last;
  }).pipe(Effect.catch(() => Effect.sync(() => (last = { ...last, error: "Activity unavailable" }))));
  return { read, rules, following, binding: () => current };
};
