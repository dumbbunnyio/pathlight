import type { ActivityEvent } from "../activity";

/** The parts of a LikeC4 view these lookups read. */
export interface WhereNode { id: unknown; modelRef?: unknown; children: readonly unknown[]; navigateTo?: unknown; title: string }
export interface WhereView<Node extends WhereNode = WhereNode> { id: unknown; title?: string | null; nodes: readonly Node[]; viewOf?: unknown }
export interface Rule { element: string; match: { match(path: string): boolean } }

/** The node in a view that draws an element, the leaf before a group when both do. */
export const nodeForElement = <Node extends WhereNode>(view: WhereView<Node>, element: string) =>
  view.nodes.filter(node => String(node.modelRef) === element).sort((a, b) => a.children.length - b.children.length)[0];

/** The elements a call's files map to. */
export const elementsOf = (rules: readonly Rule[], event: ActivityEvent) => new Set(rules.filter(rule => event.paths.some(path => rule.match.match(path))).map(rule => rule.element));

/** The element's node in this view, else the nearest ancestor that is in it. */
export const nodeOrAncestor = <Node extends WhereNode>(view: WhereView<Node>, element: string) => {
  for (let id = element; id; id = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "") {
    const node = nodeForElement(view, id);
    if (node) return node;
  }
  return undefined;
};

/**
 * Where a box that is not in this view opens: the view of its parent (the box among its siblings), else the view of the box itself, else a
 * view this one links to, else the smallest view that has it (the same last rule `w` uses).
 */
export const viewHaving = <View extends WhereView>(views: ReadonlyMap<string, View>, here: WhereView, element: string) => {
  const linked = new Set(here.nodes.map(node => node.navigateTo && String(node.navigateTo)).filter(Boolean));
  const parent = element.includes(".") ? element.slice(0, element.lastIndexOf(".")) : undefined;
  const rank = ([id, entry]: [string, View]) => {
    const subject = "viewOf" in entry ? String(entry.viewOf ?? "") : "";
    return subject && subject === parent ? 0 : subject === element ? 1 : linked.has(id) ? 2 : 3;
  };
  return [...views].filter(([, entry]) => entry.nodes.some(node => String(node.modelRef) === element))
    .sort((a, b) => rank(a) - rank(b) || a[1].nodes.length - b[1].nodes.length || Number(a[0] === "index") - Number(b[0] === "index"))[0];
};

/**
 * Boxes new to the model (no view drew them before a reload) that the view on screen does not draw, each with the view that does, chosen as
 * `viewHaving` chooses. The view on screen announces its own new cards itself.
 */
export const newElsewhere = <View extends WhereView>(views: ReadonlyMap<string, View>, here: WhereView, drawnBefore: ReadonlySet<string>) => {
  const drawnHere = new Set(here.nodes.map(node => String(node.modelRef ?? "")));
  const fresh = [...new Set([...views.values()].flatMap(entry => entry.nodes.map(node => String(node.modelRef ?? ""))))]
    .filter(element => element && !drawnBefore.has(element) && !drawnHere.has(element));
  return fresh.flatMap(element => {
    const found = viewHaving(views, here, element);
    const node = found && nodeForElement(found[1], element);
    return found && node ? [{ element, title: node.title, viewId: found[0], view: String(found[1].title ?? found[0]) }] : [];
  });
};

/**
 * The newest call that maps to any element. In this view (or via an ancestor that is) it is a node; otherwise it names the view to go to:
 * one this view links to with navigateTo first, else the smallest view that contains the element. Never switches by itself.
 */
export const newestWork = <Node extends WhereNode, View extends WhereView<Node>>(events: readonly ActivityEvent[], rules: readonly Rule[], here: WhereView<Node>, views: ReadonlyMap<string, View>):
  { node: Node } | { view: string; element: string; title: string; call: string } | undefined => {
  for (const event of events) {
    const elements = [...elementsOf(rules, event)];
    if (!elements.length) continue;
    const exact = elements.map(element => nodeForElement(here, element)).filter((node): node is Node => Boolean(node)).sort((a, b) => a.children.length - b.children.length)[0];
    if (exact) return { node: exact };
    // Another view that shows the exact component beats an enclosing group here (a group is not where the work happened).
    const linked = new Set(here.nodes.map(node => node.navigateTo && String(node.navigateTo)).filter(Boolean));
    const candidates = [...views].flatMap(([id, entry]) => entry.nodes.some(node => elements.includes(String(node.modelRef))) ? [{ id, entry, element: elements.find(element => entry.nodes.some(node => String(node.modelRef) === element)) ?? elements[0]! }] : [])
      .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || a.entry.nodes.length - b.entry.nodes.length || Number(a.id === "index") - Number(b.id === "index"));
    const best = candidates[0];
    const enclosing = elements.map(element => {
      for (let id = element; id.includes("."); ) { id = id.slice(0, id.lastIndexOf(".")); const node = nodeForElement(here, id); if (node) return node; }
      return undefined;
    }).filter((node): node is Node => Boolean(node)).sort((a, b) => a.children.length - b.children.length)[0];
    if (!best && enclosing) return { node: enclosing };
    return best ? { view: best.id, element: best.element, title: String(best.entry.title ?? best.id), call: event.call } : undefined;
  }
  return undefined;
};

export type Direction = "left" | "right" | "up" | "down";
interface Placed { id: unknown; parent?: unknown; children: readonly unknown[]; x: number; y: number; width: number; height: number }

/**
 * The arrow keys' neighbor: the nearest box in a direction, by the centers of their boxes, within a cone if any is; siblings win ties. Ancestors
 * and descendants are reached with Backspace and Enter, so they are not neighbors. Undefined when there is none.
 */
export const neighborIn = <N extends Placed>(nodes: readonly N[], current: N, direction: Direction): N | undefined => {
  const lineage = new Set<string>([String(current.id)]);
  for (let parent = nodes.find(node => node.id === current.parent); parent; parent = nodes.find(node => node.id === parent?.parent)) lineage.add(String(parent.id));
  const descend = (id: string) => { for (const child of nodes.find(node => String(node.id) === id)?.children ?? []) { lineage.add(String(child)); descend(String(child)); } };
  descend(String(current.id));
  const cx = current.x + current.width / 2, cy = current.y + current.height / 2;
  const scored = nodes.filter(node => !lineage.has(String(node.id))).flatMap(node => {
    const dx = node.x + node.width / 2 - cx, dy = node.y + node.height / 2 - cy;
    const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = Math.abs(direction === "left" || direction === "right" ? dy : dx);
    if (along <= 1) return [];
    return [{ node, cone: across <= along * 1.5, score: (along + across * 2) * (node.parent === current.parent ? 0.6 : 1) }];
  });
  const pool = scored.some(entry => entry.cone) ? scored.filter(entry => entry.cone) : scored;
  return pool.sort((a, b) => a.score - b.score)[0]?.node;
};

/** What the footer says when there is no neighbor that way. */
export const nothingThere = (direction: Direction, title: string) => `Nothing ${direction === "up" ? "above" : direction === "down" ? "below" : `to the ${direction} of`} ${title}`;
