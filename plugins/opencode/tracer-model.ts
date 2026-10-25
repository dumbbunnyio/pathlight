/**
 * Which model the `pathlight-tracer` subagent runs on. A trace is reading work that a large conversation model should not spend its tokens on, but
 * only Sonnet-class models were measured doing it well (docs/eval.md: Sonnet 4 of 5, Haiku 1 of 5), so only a Sonnet-class model is pinned on its own.
 * Anything else is a suggestion the person confirms. Pure: the OpenCode plugin hands it the models the host reports.
 */
export interface ModelInfo {
  provider: string; id: string; name: string;
  // When the model was released, in epoch milliseconds (0 when unknown).
  released: number;
  status: string;
  // Whether the person can use it now (credentials present).
  enabled: boolean;
  tools: boolean;
  // Price per million tokens, first tier. Empty when the host does not say.
  cost: { in: number; out: number }[];
}

export interface Choice {
  // `provider/id` to pin, or nothing: the tracer then runs on the person's current model.
  ref?: string;
  // Why: "option" (the person chose it), "sonnet" (the tested family), "none" (nothing tested is available).
  source: "option" | "sonnet" | "none";
  tested: boolean;
  // One sentence for the person.
  note: string;
  // For source "none": enabled models in Sonnet's price range, which nobody has measured.
  candidates: string[];
}

// Sonnet 5.5 costs $10 per million output tokens; the band below is half to double that.
const referenceOutput = 10;
const ref = (model: ModelInfo) => `${model.provider}/${model.id}`;
const usable = (model: ModelInfo) => model.enabled && model.status === "active" && model.tools;

/** Newest first, then by id so equal dates give the same answer every time. */
const newest = (a: ModelInfo, b: ModelInfo) => b.released - a.released || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function chooseTracerModel(models: readonly ModelInfo[], option?: string): Choice {
  const available = models.filter(usable);
  const wanted = option?.trim();
  if (wanted) {
    // The list is empty until the host has resolved its providers; trust the person's choice then.
    if (!models.length || models.some(model => ref(model) === wanted && model.enabled)) {
      return { ref: wanted, source: "option", tested: /claude-sonnet/i.test(wanted), note: `Traces run on ${wanted}, as set in tracerModel.`, candidates: [] };
    }
    const fallback = chooseTracerModel(models);
    return { ...fallback, note: `tracerModel is ${wanted}, which you cannot use right now. ${fallback.note}` };
  }
  const sonnet = available.filter(model => /claude-sonnet/i.test(model.id)).sort(newest)[0];
  if (sonnet) return { ref: ref(sonnet), source: "sonnet", tested: true, note: `Traces run on ${ref(sonnet)}, a Sonnet-class model. Set tracerModel to change it.`, candidates: [] };
  const candidates = available
    .filter(model => model.cost[0] && model.cost[0].out >= referenceOutput / 2 && model.cost[0].out <= referenceOutput * 2)
    .sort((a, b) => Math.abs(a.cost[0]!.out - referenceOutput) - Math.abs(b.cost[0]!.out - referenceOutput) || newest(a, b))
    .slice(0, 3).map(model => `${ref(model)} ($${model.cost[0]!.out} per million output tokens)`);
  return {
    source: "none", tested: false, candidates,
    note: candidates.length
      ? "No Sonnet-class model is available to you, so traces run on your current model. Models in Sonnet's price range (none of them tested for this): " + candidates.join(", ") + ". Ask the agent to set tracerModel."
      : "No Sonnet-class model is available to you, so traces run on your current model. Set tracerModel to choose one.",
  };
}
