import type { FlowStep, Flows, Sync } from "./flows";

/**
 * What the viewer needs from a flow: its steps in the order they are told, and which components each touches. A flow is a reading of the code (a
 * LikeC4 dynamic view, or a state diagram an agent wrote), never an observation, and the viewer draws it that way: in the agent's colour, labelled,
 * and apart from what the journal says happened.
 */
export interface FlowMap { id: string; title: string; type: "journey" | "behavior"; view: string | null; sync: Sync; findings: string[]; steps: FlowStep[] }

export const flowMaps = (flows: Flows): FlowMap[] => [
  ...flows.journeys.map(journey => ({ id: journey.id, title: journey.title, type: "journey" as const, view: journey.view, sync: journey.sync, findings: journey.findings, steps: journey.steps })),
  ...flows.flows.map(flow => ({ id: flow.id, title: flow.title, type: "behavior" as const, view: flow.view, sync: flow.sync, findings: flow.findings, steps: flow.steps })),
];

/** The 1-based steps that touch a component. A group is not in a flow because something inside it is: only the exact element counts. */
export const stepsAt = (flow: FlowMap, element: string) => flow.steps.filter(step => step.elements.includes(element)).map(step => step.n);

/** The flows a component is in, each with the steps it plays. */
export const flowsThrough = (maps: readonly FlowMap[], element: string) => maps.flatMap(flow => { const steps = stepsAt(flow, element); return steps.length ? [{ flow, steps }] : []; });

/** The flows that touch anything in a view. */
export const flowsInView = (maps: readonly FlowMap[], elements: ReadonlySet<string>) => maps.filter(flow => flow.steps.some(step => step.elements.some(element => elements.has(element))));

interface ViewNode { id: string; modelRef: string }
interface ViewEdge { source: string; target: string }

/**
 * The step numbers to write on each node. A journey step arrives at its target, so that is where its number goes; the first step's origin is the start
 * (0). A state touches every component its files belong to.
 */
export function badgesOf(flow: FlowMap, nodes: readonly ViewNode[]) {
  const badges = new Map<string, number[]>();
  const put = (element: string, n: number) => {
    for (const node of nodes) if (node.modelRef === element) badges.set(node.id, [...new Set([...badges.get(node.id) ?? [], n])].sort((a, b) => a - b));
  };
  for (const step of flow.steps) {
    if (flow.type === "journey") { if (step.n === 1 && step.from) put(step.from, 0); if (step.to) put(step.to, step.n); }
    else for (const element of step.elements) put(element, step.n);
  }
  return badges;
}

/** Where a number is written: `▶` for the start, `2·5` for a node several steps reach. */
export const badgeText = (numbers: readonly number[]) => ` ${numbers.map(n => n === 0 ? "▶" : String(n)).join("·")} `;

/** The connectors of a journey, as `source\0target` pairs of diagram node ids: the ones that run between the components of a step. A state diagram has no hops to draw. */
export function pathEdges(flow: FlowMap, nodes: readonly ViewNode[], edges: readonly ViewEdge[]) {
  const ref = new Map(nodes.map(node => [node.id, node.modelRef] as const));
  const hops = new Set(flow.type === "journey" ? flow.steps.flatMap(step => step.from && step.to ? [`${step.from}\0${step.to}`] : []) : []);
  return new Set(edges.filter(edge => hops.has(`${ref.get(edge.source)}\0${ref.get(edge.target)}`)).map(edge => `${edge.source}\0${edge.target}`));
}
