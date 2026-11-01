import { badgesOf, cardsFor, type FlowMap, flowsInView, flowsThrough } from "../flow-view";

/** The component a step lands on: a journey's target, a state's first. */
export const stepElement = (flow: FlowMap, index: number) => { const step = flow.steps[index]; return flow.type === "journey" ? step?.to : step?.elements[0]; };

/** The flows a view shows: the flow this very view draws first (its hops are the diagram), then the flows through the selection, then the rest. */
export const flowsHere = (flows: readonly FlowMap[], view: { id: unknown; nodes: readonly { modelRef?: unknown }[] }, selected: string) => {
  const present = new Set(view.nodes.map(node => String(node.modelRef)));
  const through = new Set(flowsThrough(flows, selected).map(entry => `${entry.flow.type}/${entry.flow.id}`));
  const rank = (flow: FlowMap) => (flow.view === String(view.id) ? 2 : 0) + (through.has(`${flow.type}/${flow.id}`) ? 1 : 0);
  return flowsInView(flows, present).sort((a, b) => rank(b) - rank(a));
};

/** The step that matches the selection: choosing a component yourself moves the reader to its next step in the flow. */
export const syncedStep = (flow: FlowMap, current: number, selected: string) => {
  if (!selected || stepElement(flow, current) === selected) return current;
  for (let offset = 1; offset <= flow.steps.length; offset++) {
    const index = (current + offset) % flow.steps.length;
    if (stepElement(flow, index) === selected) return index;
  }
  return current;
};

const same = (a: FlowMap, b: FlowMap) => a.type === b.type && a.id === b.id;

/** The parts of a view the choice below reads (a LikeC4 layouted view). */
export interface FlowViewCandidate { nodes: readonly { id: unknown; modelRef?: unknown }[]; viewOf?: unknown; _type?: unknown }

/**
 * The view to read a flow in: the one that draws the most distinct boxes for its steps (each step on its own card or the nearest box holding it), so
 * the numbers do not pile up on a few packages. A view must first draw both ends of every hop (a view without the box the journey starts from reads
 * as hops from nowhere), unless none does. Ties go to a view that holds the selection, then to the deepest (the view about the most nested element),
 * then to the view already shown. A journey's own dynamic view is not a candidate: the architecture is what the flow is drawn on.
 */
export const flowView = <View extends FlowViewCandidate>(flow: FlowMap, views: ReadonlyMap<string, View>, here: string, selected: string) => {
  const depth = (view: View) => view.viewOf ? String(view.viewOf).split(".").length : 0;
  const ends = [...new Set(flow.steps.flatMap(step => flow.type === "journey" ? [step.from, step.to].filter((end): end is string => Boolean(end)) : step.elements))];
  return [...views].filter(([, view]) => view._type !== "dynamic").map(([id, view]) => {
    const nodes = view.nodes.map(node => ({ id: String(node.id), modelRef: String(node.modelRef) }));
    return { id, depth: depth(view), boxes: badgesOf(flow, nodes).size, whole: ends.every(end => cardsFor(nodes, end).length > 0),
      holds: selected !== "" && view.nodes.some(node => String(node.modelRef) === selected) };
  }).filter(entry => entry.boxes > 0)
    .sort((a, b) => Number(b.whole) - Number(a.whole) || b.boxes - a.boxes || Number(b.holds) - Number(a.holds) || b.depth - a.depth || Number(b.id === here) - Number(a.id === here))[0]?.id;
};

/**
 * Flow mode: the flows read from the workspace, the one being read and its step. Stepping selects the step's component and brings it into view
 * like any other selection, and says so when it is in another view. `F` enters the flows this view shows (the ones through the selection first) and
 * cycles them, the last one leaving; Esc leaves. After a drawing was asked for (`t` with a how-question, or `d`), the first journey that appears in the
 * workspace is what the next `F` opens, whatever the selection: the file appearing is the event, nothing is observed.
 */
export function createFlowMode<Node>(options: {
  view: () => { id: unknown; nodes: readonly { modelRef?: unknown }[] }; selected: () => string; nodeFor: (element: string) => Node | undefined; select: (node: Node) => void;
  title: (element: string) => string; say: (message: string) => void; update: () => void; entering: () => void; leaving: () => void;
  /** How `F` starts reading a flow (the viewer may first go to the view that draws it best); `enter` here when not given. */
  start?: (flow: FlowMap, step: number) => void;
  /** A step whose box this view does not draw: the viewer goes to a view that does. Says so here when not given. */
  away?: (flow: FlowMap, index: number, element: string) => void;
}) {
  const mode = {
    flows: [] as FlowMap[],
    active: undefined as FlowMap | undefined,
    step: 0,
    /** The journeys there were when a drawing was asked for, while it is awaited; then the new one, until `F` opens it. */
    awaiting: undefined as Set<string> | undefined,
    drawn: undefined as FlowMap | undefined,
    goTo(index: number) {
      const flow = mode.active;
      if (!flow?.steps.length) return;
      mode.step = (index + flow.steps.length) % flow.steps.length;
      const element = stepElement(flow, mode.step), node = element ? options.nodeFor(element) : undefined;
      if (node) { options.say(""); options.select(node); }
      else if (element && options.away) options.away(flow, mode.step, element);
      else { options.say(element ? `${options.title(element)} is not in this view` : "No component for this step"); options.update(); }
    },
    enter(flow: FlowMap, step = 1) {
      mode.active = flow; mode.step = Math.max(0, Math.min(flow.steps.length - 1, step - 1));
      options.entering();
      mode.goTo(mode.step);
    },
    exit() { mode.active = undefined; options.leaving(); options.say(""); options.update(); },
    /** A drawing was asked for: the next journey that is not one of these is the one it drew. */
    expect() { mode.awaiting = new Set(mode.flows.filter(flow => flow.type === "journey").map(flow => flow.id)); },
    cycle() {
      const drawn = mode.drawn;
      const start = options.start ?? ((flow: FlowMap, step: number) => mode.enter(flow, step));
      if (drawn) { mode.drawn = undefined; start(drawn, flowsThrough([drawn], options.selected())[0]?.steps[0] ?? 1); return; }
      const here = flowsHere(mode.flows, options.view(), options.selected());
      if (!here.length) { options.say(mode.flows.length ? "No flow touches this view" : "No flows yet · select a box and press t to ask how it works"); options.update(); return; }
      const active = mode.active, at = active ? here.findIndex(flow => same(flow, active)) : -1;
      if (at === here.length - 1) { mode.exit(); return; }
      const next = here[at + 1]!, mine = flowsThrough([next], options.selected())[0]?.steps[0];
      start(next, mine ?? 1);
    },
    sync() { if (mode.active) mode.step = syncedStep(mode.active, mode.step, options.selected()); },
    /** New flows from the workspace; the one being read is kept when it is still there. */
    load(list: FlowMap[]) {
      mode.flows = list;
      const awaiting = mode.awaiting, fresh = awaiting && list.find(flow => flow.type === "journey" && !awaiting.has(flow.id));
      if (fresh) { mode.awaiting = undefined; mode.drawn = fresh; options.say(`Drawn: ${fresh.title} · F walks it`); }
      const active = mode.active;
      if (active) { mode.active = list.find(flow => same(flow, active)); if (!mode.active) options.say("That flow is gone"); }
    },
  };
  return mode;
}
