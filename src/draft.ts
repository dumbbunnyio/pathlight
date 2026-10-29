import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { failure, io, json } from "./effects";
import { configFile, home, mappingFile, modelFile, overlayFile } from "./layout";
import { run } from "./process";
import { isUnscannedSource, languageOf, listFiles, scanWorkspace, type Scan } from "./scan";
import { scannedLanguages } from "./languages";

/**
 * A first picture of a codebase made from facts alone, with no model in the loop: packages become boxes, the top-level folders
 * inside a package become components, and a relationship exists wherever files in one component import files in another. The same
 * commit always gives the same text. Names are the code's own names; nothing here is a claim about intent, so judgement
 * (better names, merged or split components) belongs in a separate layer on top.
 *
 * Folders with only a few files and loose files at the top of a package are nested in two visible collections instead of being
 * merged into a neighbour: merging would say a small module is part of whatever imports it most, which is rarely true.
 */

export interface DraftComponent {
  readonly id: string; readonly title: string; readonly files: readonly string[]; readonly globs: readonly string[];
  /** What the code is, not what it is called: stays the same when the id changes (a folder crossing three files moves between collections). The overlay is keyed by it. */
  readonly key: string; readonly note?: string;
  /** The collection this component sits in, when it is not a top-level component of its package. */
  readonly group?: string;
  /** The opened folder this component sits in (directly, or in one of its collections), when it is not in its package's own top level. */
  readonly folder?: string;
}
export interface DraftGroup { readonly id: string; readonly key: string; readonly note?: string; readonly title: string; readonly package: string; readonly kind: "small" | "loose"; /** The opened folder it sits in. */ readonly folder?: string }
/**
 * A folder drawn the way a package is: a box with its own children. The draft opens a folder that holds more than half of the read files of what holds it
 * (and has subfolders), and a `split` in the overlay opens one by hand. `parent` is the opened folder it sits in; none means its package's top level.
 */
export interface DraftFolder { readonly id: string; readonly key: string; readonly note?: string; readonly title: string; readonly package: string; readonly directory: string; readonly parent?: string; /** Opened by the rule, not by a `split`. */ readonly opened: boolean }
export interface DraftPackage {
  readonly id: string; readonly key: string; readonly note?: string; readonly title: string; /** The package.json name in full (the title drops a scope when that leaves the names unique). */ readonly name: string; readonly directory: string;
  /** Every component of the package, at whatever depth; `group` and `folder` say where each sits. */
  readonly components: readonly DraftComponent[]; readonly groups: readonly DraftGroup[]; readonly folders: readonly DraftFolder[];
}
export interface Draft {
  readonly packages: readonly DraftPackage[];
  /** True when the workspace is one package: components are then the top level. */
  readonly flat: boolean;
  readonly relationships: readonly { readonly from: string; readonly to: string; readonly imports: number; readonly title?: string }[];
  /** Overlay entries that contradict the code (a merge of folders that are gone, a pinned arrow no import supports): skipped, never drawn. */
  readonly problems: readonly string[];
  readonly ignore: readonly string[];
  readonly ignored: number;
}

/** Folders with fewer files than this go into the package's "small folders" collection (when there are several). */
export const smallFolder = 3;
/** A package with more loose files than this lists each one in a "loose files" collection; fewer stay one component. */
export const looseFiles = 3;

/** Folders and files that are deliberately outside an architecture picture. Only those that exist are listed. */
const outside = [
  { glob: "**/test/**", pattern: /(^|\/)test\// }, { glob: "**/tests/**", pattern: /(^|\/)tests\// }, { glob: "**/__tests__/**", pattern: /(^|\/)__tests__\// },
  { glob: "**/*.test.*", pattern: /\.test\.[^/]+$/ }, { glob: "**/*.spec.*", pattern: /\.spec\.[^/]+$/ },
  // Other languages' conventions, for the unread files drawn beside the code the scan reads.
  { glob: "**/*_test.go", pattern: /_test\.go$/ }, { glob: "**/test_*.py", pattern: /(^|\/)test_[^/]+\.py$/ }, { glob: "**/*_test.py", pattern: /_test\.py$/ },
];

/**
 * Every keyword in LikeC4's grammar (version 1.60.0). A folder named like one gets a trailing underscore so the model still compiles;
 * tests/draft.test.ts compares this list with the installed grammar, so an upgrade that adds a keyword fails loudly.
 */
export const likec4Keywords = [
  "BottomTop", "LeftRight", "RightLeft", "TopBottom", "agent", "alt", "amber", "and", "auto", "autoLayout", "blue", "border", "bottom", "break",
  "browser", "bucket", "catch", "color", "component", "crow", "cylinder", "dashed", "deployment", "deploymentNode", "description", "diagram",
  "diamond", "document", "dot", "dotted", "dynamic", "dynamicPredicateGroup", "element", "else", "exclude", "extend", "extends", "finally", "fixed",
  "from", "global", "gray", "green", "group", "head", "icon", "iconColor", "iconPosition", "iconSize", "icons", "if", "import", "include",
  "includeAncestors", "indigo", "instance", "instanceOf", "is", "kind", "large", "left", "lg", "likec4lib", "line", "link", "loop", "max", "md",
  "medium", "metadata", "min", "mobile", "model", "multiple", "muted", "navigateTo", "node", "none", "normal", "not", "notation", "notes",
  "odiamond", "odot", "of", "onormal", "opacity", "open", "opt", "or", "order", "ortho", "padding", "par", "parallel", "person", "predicate",
  "predicateGroup", "primary", "queue", "rank", "rectangle", "red", "relationship", "rgb", "rgba", "right", "routing", "same", "secondary",
  "sequence", "shape", "sink", "size", "sizing", "sky", "slate", "sm", "small", "solid", "source", "specification", "spline", "storage", "style",
  "styleGroup", "summary", "tag", "tail", "target", "technology", "textSize", "title", "top", "try", "variant", "vee", "view", "views", "when",
  "where", "with", "xl", "xlarge", "xs", "xsmall"
] as const;
const reserved = new Set(likec4Keywords.map(word => word.toLowerCase()));

const slug = (text: string) => {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";
  const safe = /^[0-9]/.test(base) ? `p_${base}` : base;
  return reserved.has(safe) ? `${safe}_` : safe;
};
const unique = (wanted: string, taken: Set<string>) => {
  let id = wanted;
  for (let n = 2; taken.has(id); n++) id = `${wanted}_${n}`;
  taken.add(id);
  return id;
};
const escapeGlob = (text: string) => text.replace(/[\\*?[\]{}()!]/g, "\\$&");
const braces = (names: readonly string[]) => names.length === 1 ? escapeGlob(names[0]!) : `{${names.map(escapeGlob).join(",")}}`;
const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * What holds components: a package, or a folder the draft opened. `rel` is a file's path inside it (a package strips its source root), `folderPath` the
 * workspace path of one of its folders, `prefixOf` the path a file's folder is claimed under, `joins` whether `x.ts` beside `x/` is one module there.
 */
interface Holder {
  readonly files: readonly string[]; readonly key: string; readonly packageId: string; readonly folder?: string;
  readonly rel: (path: string) => string; readonly folderPath: (top: string) => string; readonly prefixOf: (path: string, top: string) => string;
  readonly qualify: (id: string) => string; readonly joins: (path: string) => boolean;
}

/**
 * `unread`: source files in languages the scan does not read (`isUnscannedSource`). They are drawn in the folders they live in, so the picture
 * leaves no part of the code out, but they bring no imports: an arrow to or from them is never drawn, and their description says so.
 */
export function draftOf(scan: Pick<Scan, "files" | "imports">, manifests: readonly { directory: string; name: string }[], overlay?: Overlay, unread: readonly string[] = []): Draft {
  const problems: string[] = [];
  const splits = new Set((overlay?.splits ?? []).map(item => item.key));
  const splitSeen = new Set<string>(), splitOpened = new Set<string>();
  const merges = (overlay?.merges ?? []).map((item, index) => ({ ...item, index, applied: false }));
  const mergedKeys = new Set<string>();
  const ignoredBy = (path: string) => outside.find(item => item.pattern.test(path));
  const source = [...scan.files.map(file => file.path), ...unread], unreadSet = new Set(unread);
  const kept = source.filter(path => !ignoredBy(path));
  const ignore = outside.filter(item => source.some(path => item.pattern.test(path))).map(item => item.glob);

  // The package a file belongs to is the nearest package.json above it.
  const named = [...manifests].sort((a, b) => b.directory.length - a.directory.length);
  const ownerOf = (path: string) => named.find(item => item.directory === "" || path.startsWith(`${item.directory}/`));
  const byPackage = new Map<string, string[]>();
  for (const path of kept) {
    const key = ownerOf(path)?.directory ?? "";
    byPackage.set(key, [...byPackage.get(key) ?? [], path]);
  }
  const flat = byPackage.size <= 1;

  const taken = new Set<string>();
  const componentOf = new Map<string, string>();
  const packages: DraftPackage[] = [];
  const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, "").replace(/\.(d|config|test|spec)$/, "");
  const fileGlobs = (members: readonly string[]) => {
    const byDirectory = new Map<string, string[]>();
    for (const path of members) byDirectory.set(posix.dirname(path), [...byDirectory.get(posix.dirname(path)) ?? [], posix.basename(path)]);
    return [...byDirectory].sort(([a], [b]) => byText(a, b)).map(([folder, names]) => `${folder === "." ? "" : `${folder.split("/").map(escapeGlob).join("/")}/`}${braces(names.sort())}`);
  };
  // Only files the scan reads decide what opens, as they decide the source root: adding unread files never regroups a package.
  const readCount = (members: readonly string[]) => members.filter(path => !unreadSet.has(path)).length;
  // A folder holds subfolders when some file lies two levels below it.
  const deeper = (directory: string, members: readonly string[]) => members.some(path => path.startsWith(`${directory}/`) && path.slice(directory.length + 1).includes("/"));
  // A folder whose files all sit in one subfolder is not several things: the rule looks at that subfolder instead, so `src/main/java/org/acme/app` opens at
  // `app`. A chain that ends in a folder with no subfolders opens nothing.
  const opening = (directory: string, members: readonly string[]): string | undefined => {
    if (!deeper(directory, members)) return undefined;
    const next = new Set(members.map(path => path.startsWith(`${directory}/`) && path.slice(directory.length + 1).includes("/") ? path.slice(directory.length + 1).split("/")[0] : ""));
    return next.size === 1 && !next.has("") ? opening(`${directory}/${[...next][0]}`, members) : directory;
  };

  /** Lays out the components, collections and opened folders of a package or an opened folder, the same rules at every depth. */
  const lay = (box: Holder, out: { components: DraftComponent[]; groups: DraftGroup[]; folders: DraftFolder[] }) => {
    const segment = (path: string) => { const rel = box.rel(path); return rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : ""; };
    const folders = new Set(box.files.map(segment).filter(Boolean));
    // `session.ts` beside a `session/` folder is one module; every other loose file is a loose file.
    const keyOf = (path: string) => segment(path) || (folders.has(stem(path)) && box.joins(path) ? stem(path) : "");
    const groups = new Map<string, string[]>();
    for (const path of box.files) groups.set(keyOf(path), [...groups.get(keyOf(path)) ?? [], path]);

    // A folder is claimed whole (`folder/**`) only when everything under it belongs to the component; a folder that also holds another
    // package's files (a root package whose `packages/` folder contains the others) is claimed file by file so no file has two owners.
    const folderGlobs = (members: readonly string[]) => {
      const owned = new Set(members);
      const found = new Set<string>(), explicit: string[] = [];
      for (const path of members) {
        const folder = segment(path);
        if (!folder) continue;
        const prefix = box.prefixOf(path, folder);
        if (kept.some(other => other.startsWith(`${prefix}/`) && !owned.has(other))) explicit.push(path);
        else found.add(`${prefix.split("/").map(escapeGlob).join("/")}/**`);
      }
      return [...[...found].sort(), ...fileGlobs(explicit)];
    };
    const globsOf = (key: string) => { const members = groups.get(key)!; return [...folderGlobs(members), ...fileGlobs(members.filter(path => !segment(path)))]; };
    // A merge applies in a package only when every folder it names is there; the folders then become one top-level component.
    const mergedUnits: { title: string; key: string; files: string[]; globs: string[] }[] = [];
    for (const item of merges) {
      const here = item.keys.map(key => [...groups.keys()].find(candidate => candidate && box.folderPath(candidate) === key));
      if (item.applied || here.some(found => found === undefined) || here.some(found => mergedKeys.has(found!))) continue;
      item.applied = true;
      const names = here as string[];
      for (const name of names) mergedKeys.add(name);
      mergedUnits.push({ title: item.title, key: `merge:${item.title}`, files: names.flatMap(name => groups.get(name)!), globs: [...new Set(names.flatMap(globsOf))].sort() });
    }
    const folderKeys = [...groups.keys()].filter(key => key && !mergedKeys.has(key)).sort();
    // A folder opens when it is most of what holds it and too big to be one box, or nearly all of it (the view above would be one box and crumbs),
    // or when the overlay splits it; it is then drawn the way a package is.
    const total = readCount(box.files);
    const opens = (count: number) => count * 2 > total && (count >= openFloor || count / total >= openShare);
    const opened = new Map<string, { directory: string; split: boolean }>();
    for (const key of folderKeys) {
      const path = box.folderPath(key), members = groups.get(key)!;
      if (splits.has(path)) {
        splitSeen.add(path);
        if (deeper(path, members)) { splitOpened.add(path); opened.set(key, { directory: path, split: true }); }
        continue;
      }
      const directory = opens(readCount(members)) ? opening(path, members) : undefined;
      if (directory) opened.set(key, { directory, split: false });
    }
    const small = folderKeys.filter(key => !opened.has(key) && groups.get(key)!.length < smallFolder);
    const loose = (groups.get("") ?? []).sort();
    // A collection only exists when it would hold several things; one small folder or a few loose files stay ordinary components.
    const smallGroup = small.length >= 3, looseGroup = loose.length > looseFiles;
    const inFolder = box.folder ? { folder: box.folder } : {};
    if (smallGroup) out.groups.push({ id: box.qualify("small"), key: `${box.key}#small`, title: "small folders", package: box.packageId, kind: "small", ...inFolder });
    if (looseGroup) out.groups.push({ id: box.qualify("loose"), key: `${box.key}#loose`, title: "loose files", package: box.packageId, kind: "loose", ...inFolder });

    const componentTaken = new Set<string>(["small", "loose"]);
    const add = (id: string, key: string, componentTitle: string, members: string[], globs: string[], group?: string) => {
      const full = group ? `${group}.${id}` : box.qualify(id);
      for (const path of members) componentOf.set(path, full);
      out.components.push({ id: full, key, title: componentTitle, files: members.sort(), globs, ...(group ? { group } : {}), ...inFolder });
    };
    const smallTaken = new Set<string>();
    for (const key of folderKeys) {
      const members = groups.get(key)!;
      const open = opened.get(key);
      if (open) {
        // Its children are titled by their own name, since the box they sit in names the rest, and keyed by their path.
        const title = posix.basename(open.directory), id = box.qualify(unique(slug(open.split ? key : title), componentTaken));
        out.folders.push({ id, key: open.directory, title, package: box.packageId, directory: open.directory, ...(box.folder ? { parent: box.folder } : {}), opened: !open.split });
        const directory = open.directory;
        lay({ files: members, key: directory, packageId: box.packageId, folder: id, rel: path => path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : posix.basename(path),
          folderPath: top => `${directory}/${top}`, prefixOf: (_, top) => `${directory}/${top}`, qualify: child => `${id}.${child}`, joins: () => true }, out);
        continue;
      }
      const inSmall = smallGroup && small.includes(key);
      add(unique(slug(key), inSmall ? smallTaken : componentTaken), box.folderPath(key), key, members, globsOf(key), inSmall ? box.qualify("small") : undefined);
    }
    for (const unit of mergedUnits) add(unique(slug(unit.title), componentTaken), unit.key, unit.title, unit.files, unit.globs);
    if (loose.length) {
      if (looseGroup) {
        const leaves = new Set<string>();
        for (const path of loose) add(unique(slug(stem(path)), leaves), path, posix.basename(path), [path], fileGlobs([path]), box.qualify("loose"));
      } else add(unique("root", componentTaken), `${box.key}#loose`, "loose files", loose, fileGlobs(loose));
    }
  };

  for (const directory of [...byPackage.keys()].sort()) {
    const files = byPackage.get(directory)!;
    const manifest = named.find(item => item.directory === directory);
    const name = manifest?.name ?? (directory || "workspace");
    const short = name.replace(/^@[^/]+\//, "");
    // A box is only as wide as its label: lead with the package's own name, and keep the scope only where two packages would read the same.
    const title = manifests.filter(other => other.name.replace(/^@[^/]+\//, "") === short).length > 1 ? name : short;
    const packageId = flat ? "" : unique(slug(short), taken);
    const inside = (path: string) => (directory ? path.slice(directory.length + 1) : path);
    // Source lives under src/ when most of the package does; files elsewhere keep their own top folder. Only files the scan reads decide it,
    // so adding unread files never regroups a package (and never orphans the names already given to its folders).
    const read = files.filter(path => !unreadSet.has(path));
    const sourceRoot = read.filter(path => inside(path).startsWith("src/")).length * 2 >= read.length ? "src/" : "";
    // A top folder is under the source root only if some of its files are; `benchmarks/` beside `src/` is `benchmarks`, not `src/benchmarks`.
    const inSource = (top: string) => files.some(path => inside(path).startsWith(`${sourceRoot}${top}/`));
    const out = { components: [] as DraftComponent[], groups: [] as DraftGroup[], folders: [] as DraftFolder[] };
    lay({
      files, key: directory || ".", packageId,
      rel: path => { const rel = inside(path); return rel.startsWith(sourceRoot) ? rel.slice(sourceRoot.length) : rel; },
      folderPath: top => [directory, sourceRoot && inSource(top) ? sourceRoot.replace(/\/$/, "") : "", top].filter(Boolean).join("/"),
      prefixOf: (path, top) => `${[directory, inside(path).startsWith(sourceRoot) ? sourceRoot.replace(/\/$/, "") : ""].filter(Boolean).join("/")}/${top}`.replace(/^\//, ""),
      qualify: id => packageId ? `${packageId}.${id}` : id,
      joins: path => Boolean(sourceRoot) && inside(path).startsWith(sourceRoot),
    }, out);
    out.components.sort((a, b) => byText(a.id, b.id));
    packages.push({ id: packageId, key: directory || ".", title, name, directory, components: out.components, groups: out.groups, folders: out.folders });
  }

  // Imports can name files that are not source (a stylesheet, a JSON file): they belong to whichever component's globs claim them.
  const claims = packages.flatMap(item => item.components.map(entry => ({ id: entry.id, globs: entry.globs.map(glob => new Bun.Glob(glob)) })));
  const claimed = new Map<string, string | undefined>();
  const ownerOfFile = (path: string) => {
    if (componentOf.has(path)) return componentOf.get(path);
    if (!claimed.has(path)) claimed.set(path, ignoredBy(path) ? undefined : claims.find(claim => claim.globs.some(glob => glob.match(path)))?.id);
    return claimed.get(path);
  };
  const counts = new Map<string, number>();
  for (const item of scan.imports) {
    const from = ownerOfFile(item.from), to = ownerOfFile(item.to);
    if (from && to && from !== to) counts.set(`${from}\0${to}`, (counts.get(`${from}\0${to}`) ?? 0) + 1);
  }
  const relationships = [...counts].map(([key, imports]) => { const [from, to] = key.split("\0") as [string, string]; return { from, to, imports }; })
    .sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to));

  for (const item of merges) if (!item.applied) problems.push(`merge '${item.title}': every folder it names must exist in one package and be in no other merge (${item.keys.join(", ")}).`);
  for (const key of splits) {
    if (!splitSeen.has(key)) problems.push(`split '${key}': no folder of the draft has that path.`);
    else if (!splitOpened.has(key)) problems.push(`split '${key}': the folder has no subfolders with source files.`);
  }
  // Pinned relationship titles only label an arrow that imports already support; they never create one.
  const idOf = new Map(packages.flatMap(item => item.components.map(entry => [entry.key, entry.id] as const)));
  for (const item of merges.filter(entry => entry.applied)) for (const key of item.keys) idOf.set(key, idOf.get(`merge:${item.title}`)!);
  const titled = new Map<string, string>();
  for (const pin of overlay?.relationships ?? []) {
    const from = idOf.get(pin.from), to = idOf.get(pin.to);
    if (!from || !to) problems.push(`relationship '${pin.from}' → '${pin.to}': ${!from ? pin.from : pin.to} is not a component of the draft.`);
    else if (!relationships.some(edge => edge.from === from && edge.to === to)) problems.push(`relationship '${pin.from}' → '${pin.to}': no import runs from the first to the second, so there is no arrow to title.`);
    else titled.set(`${from}\0${to}`, pin.title);
  }
  const labelled = relationships.map(edge => titled.has(`${edge.from}\0${edge.to}`) ? { ...edge, title: titled.get(`${edge.from}\0${edge.to}`)! } : edge);
  return { packages, flat, relationships: labelled, problems, ignore, ignored: source.length - kept.length };
}

const quote = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const generatedMarker = "// Generated by `pathlight draft` from the code. Do not edit by hand: rerun it, and keep names and notes in an overlay.";

/** Connection weights a view can hide, weakest first: a relationship carries `lt<N>` for every N above its import count. */
const tiers = [2, 3, 5, 10, 20, 50, 100] as const;

/**
 * Every relationship stays in the model; a view hides the weakest tiers until it has about as many lines as a terminal can show
 * (never fewer than the strongest tier that leaves any), and its description says so.
 */
const thinning = (nodes: number, shown: (minimum: number) => number) => {
  const cap = Math.max(24, Math.round(nodes * 1.6));
  for (const minimum of [1, ...tiers]) if (shown(minimum) <= cap) return minimum;
  return tiers.filter(minimum => shown(minimum) > 0).at(-1) ?? 1;
};

/** More boxes than this in one overview view is more than a person reads at once; the weakest beyond it move to a view that lists everything. */
export const viewCap = 16;
/** A folder holding more than half of its package's (or opened folder's) read files opens when it also holds at least this many of them… */
export const openFloor = 100;
/** …or at least this share of them. */
export const openShare = 0.9;
/** An opened folder's own view draws this many of its children as cards (its collections among them); the rest are in its "everything" view. */
export const folderCap = 9;
/** A readable view holds at most this many boxes in all: its own members plus the neighbours that connect to them. */
export const crowdedAbove = 20;

/**
 * Folders and config files that build, measure or exercise a package rather than being part of it. They stay in the model and in every
 * "everything" view, but they never count towards what a package depends on and they are the first to move out of an overview.
 */
export const isTooling = (key: string) => {
  const name = posix.basename(key).toLowerCase();
  return /^(benchmarks?|bench|build|scripts|e2e|examples?|fixtures|docs|runtime-tests|perf(-.*)?)$/.test(name)
    || /^(vite|vitest|jest|rollup|tsup|webpack|eslint|babel|esbuild)\.config\.[cm]?[jt]s$/.test(name);
};

export interface Analysis {
  /** How much each package and component connects to the rest, in imports (a collection counts its members). */
  readonly weight: ReadonlyMap<string, number>;
  /** Packages and components left out of overview views, the weakest beyond the cap; the "all" views still show them. */
  readonly minor: ReadonlySet<string>;
  /** Packages that import each other in a loop, and, per package, components that do. Each loop is a list of ids. */
  readonly packageCycles: readonly (readonly string[])[];
  readonly componentCycles: ReadonlyMap<string, readonly (readonly string[])[]>;
}

/** Strongly connected sets of more than one node (Tarjan): nodes that can all reach each other. */
export function loops(nodes: readonly string[], edges: readonly (readonly [string, string])[]): string[][] {
  const next = new Map<string, string[]>(nodes.map(node => [node, []]));
  for (const [from, to] of edges) if (next.has(from) && next.has(to) && from !== to) next.get(from)!.push(to);
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [], found: string[][] = [];
  let counter = 0;
  const visit = (node: string) => {
    index.set(node, counter); low.set(node, counter); counter++; stack.push(node); onStack.add(node);
    for (const target of next.get(node)!) {
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node)!, low.get(target)!)); }
      else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!));
    }
    if (low.get(node) === index.get(node)) {
      const members: string[] = [];
      for (let member = stack.pop()!; ; member = stack.pop()!) { onStack.delete(member); members.push(member); if (member === node) break; }
      if (members.length > 1) found.push(members.sort(byText));
    }
  };
  for (const node of [...nodes].sort(byText)) if (!index.has(node)) visit(node);
  return found.sort((a, b) => byText(a[0]!, b[0]!));
}

/**
 * The lines that prove each member of a loop is in one: for every member, the shortest way back to it. A report of a cycle needs these,
 * not every line among the members (a set of fifty that all import each other has over two thousand). The strongest lines are kept
 * when even these are too many to lay out.
 */
export function witness(members: readonly string[], edges: readonly { from: string; to: string; imports: number }[], limit = 60): { edges: { from: string; to: string; imports: number }[]; complete: boolean } {
  const set = new Set(members);
  const next = new Map<string, { to: string; imports: number }[]>(members.map(member => [member, []]));
  for (const edge of edges) if (set.has(edge.from) && set.has(edge.to) && edge.from !== edge.to) next.get(edge.from)!.push({ to: edge.to, imports: edge.imports });
  for (const list of next.values()) list.sort((a, b) => byText(a.to, b.to));
  const weight = new Map(edges.map(edge => [`${edge.from}\0${edge.to}`, edge.imports] as const));
  const chosen = new Map<string, { from: string; to: string; imports: number }>();
  const take = (from: string, to: string) => chosen.set(`${from}\0${to}`, { from, to, imports: weight.get(`${from}\0${to}`) ?? 0 });
  for (const start of [...members].sort(byText)) {
    // Breadth first from each way out of `start`, until `start` is reached again.
    const parent = new Map<string, string>();
    const queue: string[] = [];
    for (const { to } of next.get(start)!) { if (!parent.has(to)) { parent.set(to, start); queue.push(to); } }
    let found = false;
    for (let at = 0; at < queue.length && !found; at++) {
      for (const { to } of next.get(queue[at]!)!) {
        if (to === start) { let node = queue[at]!; take(node, start); while (parent.get(node) !== start) { const before = parent.get(node)!; take(before, node); node = before; } take(start, node); found = true; break; }
        if (!parent.has(to)) { parent.set(to, queue[at]!); queue.push(to); }
      }
    }
  }
  const all = [...chosen.values()].sort((a, b) => b.imports - a.imports || byText(a.from, b.from) || byText(a.to, b.to));
  return { edges: all.slice(0, limit).sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to)), complete: all.length <= limit };
}

/**
 * Where everything sits: the chain of what holds an element, from its package down (no package in a flat draft), and what a view scoped to some holder draws
 * for any element: the holder's child that contains it, or, outside the holder, the element where the two chains part (a sibling, a collection, a package).
 */
const placesOf = (draft: Draft) => {
  const chains = new Map<string, readonly string[]>();
  for (const item of draft.packages) {
    const top = draft.flat ? [] : [item.id];
    const parents = new Map(item.folders.map(folder => [folder.id, folder.parent] as const));
    const above = (folder: string | undefined): string[] => folder ? [...above(parents.get(folder)), folder] : [];
    if (!draft.flat) chains.set(item.id, top);
    for (const folder of item.folders) chains.set(folder.id, [...top, ...above(folder.id)]);
    for (const group of item.groups) chains.set(group.id, [...top, ...above(group.folder), group.id]);
    for (const entry of item.components) chains.set(entry.id, [...top, ...above(entry.folder), ...(entry.group ? [entry.group] : []), entry.id]);
  }
  const drawnIn = (scope: readonly string[]) => (id: string) => {
    const chain = chains.get(id) ?? [id];
    let at = 0;
    while (at < scope.length && chain[at] === scope[at]) at++;
    return chain[at];
  };
  return { chain: (id: string) => chains.get(id) ?? [id], drawnIn };
};

/** What a package (no `folder`) or an opened folder holds directly: its components and folders, which compete for room, and its collections. */
const childrenOf = (item: DraftPackage, folder?: string) => ({
  members: [...item.components.filter(entry => !entry.group && entry.folder === folder).map(entry => entry.id), ...item.folders.filter(inner => inner.parent === folder).map(inner => inner.id)].sort(byText),
  groups: item.groups.filter(group => group.folder === folder).map(group => group.id),
  folders: item.folders.filter(inner => inner.parent === folder).map(inner => inner.id),
});

export function analyse(draft: Draft): Analysis {
  const packageOf = new Map(draft.packages.flatMap(item => item.components.map(entry => [entry.id, item.id] as const)));
  const { chain, drawnIn } = placesOf(draft);
  const weight = new Map<string, number>();
  const add = (id: string, n: number) => weight.set(id, (weight.get(id) ?? 0) + n);
  const tooling = new Set(draft.packages.flatMap(item => item.components.filter(entry => isTooling(entry.key)).map(entry => entry.id)));
  for (const edge of draft.relationships) {
    // What a benchmark or a build script imports says nothing about what the product depends on.
    if (tooling.has(edge.from)) continue;
    add(edge.from, edge.imports); add(edge.to, edge.imports);
    const a = packageOf.get(edge.from), b = packageOf.get(edge.to);
    if (!draft.flat && a && b && a !== b) { add(a, edge.imports); add(b, edge.imports); }
    // An opened folder counts what crosses its edge, as a package does.
    const into = new Set(chain(edge.to)), outOf = new Set(chain(edge.from));
    for (const folder of draft.packages.flatMap(item => item.folders)) if (outOf.has(folder.id) !== into.has(folder.id)) add(folder.id, edge.imports);
  }
  const filesIn = (item: DraftPackage, id: string) => item.components.filter(entry => entry.id === id || entry.id.startsWith(`${id}.`)).reduce((sum, entry) => sum + entry.files.length, 0);
  const ranked = (ids: readonly string[], files: (id: string) => number) => [...ids].sort((a, b) =>
    Number(tooling.has(a)) - Number(tooling.has(b)) || (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || files(b) - files(a) || byText(a, b));
  const minor = new Set<string>();
  if (!draft.flat && draft.packages.length > viewCap) {
    const filesOf = (id: string) => draft.packages.find(item => item.id === id)!.components.reduce((sum, entry) => sum + entry.files.length, 0);
    for (const id of ranked(draft.packages.map(item => item.id), filesOf).slice(viewCap)) minor.add(id);
  }
  // What a view of a set of components also draws: the other packages (or, in one package, the other nodes) they connect to.
  const neighboursOf = (inside: ReadonlySet<string>, drawn: (id: string) => string | undefined) => new Set(draft.relationships
    .filter(edge => inside.has(edge.from) !== inside.has(edge.to)).map(edge => drawn(inside.has(edge.from) ? edge.to : edge.from)).filter(Boolean)).size;
  for (const item of draft.packages) {
    const { members: top, groups } = childrenOf(item);
    const own = new Set(item.components.map(entry => entry.id));
    // The box drawn around the package is one more node.
    const room = Math.max(5, crowdedAbove - 1 - groups.length - neighboursOf(own, id => packageOf.get(id)));
    if (top.length <= room) continue;
    for (const id of ranked(top, id => filesIn(item, id)).slice(room)) minor.add(id);
  }
  // An opened folder draws its strongest children as cards, its collections among them, and leaves the rest to its "everything" view.
  for (const item of draft.packages) for (const folder of item.folders) {
    const { members, groups } = childrenOf(item, folder.id);
    const inside = new Set(item.components.filter(entry => entry.id.startsWith(`${folder.id}.`)).map(entry => entry.id));
    const room = Math.min(folderCap - groups.length, Math.max(5, crowdedAbove - 1 - groups.length - neighboursOf(inside, drawnIn(chain(folder.id)))));
    if (members.length <= room) continue;
    for (const id of ranked(members, id => filesIn(item, id)).slice(room)) minor.add(id);
  }
  // A collection that holds more than a view can show lists its strongest members and leaves the rest to its "everything" view.
  for (const item of draft.packages) for (const group of item.groups) {
    const members = item.components.filter(entry => entry.group === group.id);
    const room = Math.max(5, crowdedAbove - 1 - neighboursOf(new Set(members.map(entry => entry.id)), id => (packageOf.get(id) === item.id ? id : packageOf.get(id))));
    if (members.length <= room) continue;
    for (const id of ranked(members.map(entry => entry.id), id => members.find(entry => entry.id === id)!.files.length).slice(room)) minor.add(id);
  }
  const packageEdges = draft.relationships.flatMap(edge => { const a = packageOf.get(edge.from), b = packageOf.get(edge.to); return a && b && a !== b ? [[a, b] as const] : []; });
  const componentCycles = new Map<string, string[][]>();
  for (const item of draft.packages) {
    const own = item.components.map(entry => entry.id), owned = new Set(own);
    const found = loops(own, draft.relationships.filter(edge => owned.has(edge.from) && owned.has(edge.to)).map(edge => [edge.from, edge.to] as const));
    if (found.length) componentCycles.set(item.id, found);
  }
  return { weight, minor, packageCycles: draft.flat ? [] : loops(draft.packages.map(item => item.id), packageEdges), componentCycles };
}

const loopNote = (found: readonly (readonly string[])[]) => found.length === 1 ? `${found[0]!.length} in one loop.` : `${found.length} loops, the largest of ${Math.max(...found.map(item => item.length))}.`;
const viewName = (id: string) => id.replace(/\./g, "_");
const componentsView = (id: string) => `${viewName(id)}_components`;
const allView = (id: string) => `${viewName(id)}_all_components`;
const nearView = (id: string) => `${viewName(id)}_near`;
const cyclesView = (id: string) => `${viewName(id)}_cycles`;

/** `behavior`: a `*.behavior.c4` file sits beside the draft, so the views that list every top-level element leave out what it tags `#behavior`. */
export function renderDraft(draft: Draft, lines: ReadonlyMap<string, number> = new Map(), behavior = false, unread: ReadonlySet<string> = new Set()) {
  const notBehavior = behavior ? ["    exclude * where tag is #behavior"] : [];
  const analysis = analyse(draft);
  const { minor } = analysis;
  const inCycle = new Set([...analysis.componentCycles.values()].flatMap(found => found.flat()));
  const inPackageCycle = new Set(analysis.packageCycles.flat());
  const entries: string[] = [];
  const out: string[] = [generatedMarker, "", "specification {", ...(draft.flat ? [] : ["  element package"]), ...(draft.packages.some(item => item.folders.length) ? ["  element folder"] : []), "  element collection", "  element component", ...tiers.map(tier => `  tag lt${tier}`), "  tag minor", "  tag cycle", "  tag pkgcycle", "}", "", "model {"];
  // Files in a language the scan does not read are counted and named by language, and the description says their connections are not drawn.
  const languages = (files: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const path of files) counts.set(languageOf(path), (counts.get(languageOf(path)) ?? 0) + 1);
    return [...counts].sort(([a, x], [b, y]) => y - x || byText(a, b)).map(([language, count]) => `${count} ${language}`).join(", ");
  };
  const facts = (files: readonly string[]) => {
    const total = `${(files.reduce((sum, path) => sum + (lines.get(path) ?? 0), 0)).toLocaleString("en-US")} lines`, notRead = files.filter(path => unread.has(path));
    if (!notRead.length) return `${plural(files.length, "file")}, ${total}`;
    if (notRead.length === files.length) return `${languages(notRead)} ${files.length === 1 ? "file" : "files"}, ${total}, not read by the scan: its connections are not drawn`;
    return `${plural(files.length, "file")}, ${total} (${languages(notRead)} not read by the scan)`;
  };
  const said = (note: string | undefined, text: string) => note ? `${note} · ${text}` : text;
  const local = (id: string, parent: string) => parent ? id.slice(parent.length + 1) : id;
  const tagsOf = (id: string, kind: "package" | "component") => [...(minor.has(id) ? ["#minor"] : []), ...(kind === "package" ? (inPackageCycle.has(id) ? ["#pkgcycle"] : []) : (inCycle.has(id) ? ["#cycle"] : []))];
  const tagLine = (id: string, kind: "package" | "component", indent: string) => { const tags = tagsOf(id, kind); return tags.length ? [`${indent}${tags.join(" ")}`] : []; };
  // What a package or an opened folder holds directly: its components, the folders it opened, then its collections.
  const block = (item: DraftPackage, indent: string, parent: string, folder?: DraftFolder) => {
    const result: string[] = [];
    for (const entry of item.components.filter(candidate => !candidate.group && candidate.folder === folder?.id)) result.push(`${indent}${local(entry.id, parent)} = component ${quote(entry.title)} {`, ...tagLine(entry.id, "component", `${indent}  `), `${indent}  description ${quote(said(entry.note, facts(entry.files)))}`, `${indent}}`);
    for (const inner of item.folders.filter(candidate => candidate.parent === folder?.id)) {
      result.push(`${indent}${local(inner.id, parent)} = folder ${quote(inner.title)} {`, ...tagLine(inner.id, "component", `${indent}  `), `${indent}  description ${quote(said(inner.note, facts(item.components.filter(entry => entry.id.startsWith(`${inner.id}.`)).flatMap(entry => entry.files))))}`, ...block(item, `${indent}  `, inner.id, inner), `${indent}}`);
    }
    // A collection of small folders says how many folders; one of loose files would only say its file count twice.
    for (const group of item.groups.filter(candidate => candidate.folder === folder?.id)) {
      const members = item.components.filter(candidate => candidate.group === group.id);
      result.push(`${indent}${local(group.id, parent)} = collection ${quote(group.title)} {`, `${indent}  description ${quote(said(group.note, `${group.kind === "small" ? `${plural(members.length, "folder")}, ` : ""}${facts(members.flatMap(entry => entry.files))}`))}`);
      for (const entry of members) result.push(`${indent}  ${local(entry.id, group.id)} = component ${quote(entry.title)} {`, ...tagLine(entry.id, "component", `${indent}    `), `${indent}    description ${quote(said(entry.note, facts(entry.files)))}`, `${indent}  }`);
      result.push(`${indent}}`);
    }
    return result;
  };
  for (const item of draft.packages) {
    if (draft.flat) { out.push(...block(item, "  ", "")); continue; }
    out.push(`  ${item.id} = package ${quote(item.title)} {`, ...tagLine(item.id, "package", "    "), `    description ${quote(said(item.note, `${item.name === item.title ? "" : `${item.name}: `}${facts(item.components.flatMap(entry => entry.files))}`))}`, ...block(item, "    ", item.id), "  }");
  }
  out.push("");
  for (const edge of draft.relationships) {
    const weak = tiers.filter(tier => edge.imports < tier).map(tier => `#lt${tier}`);
    const inner = [...(weak.length ? [weak.join(" ")] : []), ...(edge.title ? [`description ${quote(plural(edge.imports, "import"))}`] : [])];
    out.push(`  ${edge.from} -> ${edge.to} ${quote(edge.title ?? plural(edge.imports, "import"))}${inner.length ? ` {\n${inner.map(line => `    ${line}`).join("\n")}\n  }` : ""}`);
  }
  out.push("}", "", "views {");

  const packageOf = new Map(draft.packages.flatMap(item => item.components.map(entry => [entry.id, item.id] as const)));
  const connected = new Set(draft.relationships.flatMap(edge => [edge.from, edge.to]));
  // LikeC4 wants a view's properties before its predicates.
  const describe = (...sentences: (string | undefined)[]) => { const text = sentences.filter(Boolean).join(" "); return text ? [`    description ${quote(text)}`] : []; };
  const thinNote = (minimum: number) => minimum > 1 ? `Connections with fewer than ${minimum} imports are hidden here. Select a component to see all of its connections.` : undefined;
  const hide = (minimum: number) => minimum > 1 ? [`    exclude * -> * where tag is #lt${minimum}`] : [];
  // The exclusion would take a minor element out of its own view, leaving its children loose with no frame; it is put back (by its full id, which a
  // child of the same name does not shadow).
  const withoutMinor = (scope: string) => ["    exclude * where tag is #minor", ...(minor.has(scope) ? [`    include ${scope}`] : [])];
  // Inside a view scoped to an element, names resolve against that element first, so its children are named locally ("app.loose.app" would
  // find the child `app` and look for `loose` below it); an unscoped view names things in full.
  const links = (shown: readonly string[], group: ReadonlySet<string>, scope?: string) => shown.flatMap(id => group.has(id) || connected.has(id)
    ? [`    include ${scope ? id.slice(scope.length + 1) : id} with {`, `      navigateTo ${group.has(id) ? componentsView(id) : nearView(id)}`, "    }"] : []);

  /**
   * A view shows what is inside its scope plus what that connects to; every other thing is drawn as `drawn(id)` (itself, the collection
   * that holds it when closed, or its package). The weakest connections are hidden until the line count is readable.
   */
  const thinned = (inScope: (id: string) => boolean, drawn: (id: string) => string | undefined, members: readonly string[]) => {
    const relevant = draft.relationships.filter(edge => inScope(edge.from) || inScope(edge.to));
    const nodes = new Set([...members, ...relevant.flatMap(edge => [drawn(edge.from), drawn(edge.to)])].filter(Boolean));
    return thinning(nodes.size, minimum => new Set(relevant.filter(edge => edge.imports >= minimum)
      .flatMap(edge => { const from = drawn(edge.from), to = drawn(edge.to); return from && to && from !== to ? [`${from}\0${to}`] : []; })).size);
  };
  const groupView = (item: DraftPackage, group: DraftGroup, drawnOutside: (id: string) => string | undefined, title = draft.flat ? group.title : `${item.title} / ${group.title}`) => {
    const inGroup = new Set(item.components.filter(entry => entry.group === group.id).map(entry => entry.id));
    const shown = [...inGroup].filter(id => !minor.has(id)).sort(byText);
    const minimum = thinned(id => inGroup.has(id), id => minor.has(id) ? undefined : inGroup.has(id) ? id : drawnOutside(id), shown);
    const result = ["", `  view ${componentsView(group.id)} of ${group.id} {`, `    title ${quote(title)}`, ...describe(hidden(inGroup.size - shown.length, allView(group.id)), thinNote(minimum)), "    include *", ...links(shown, new Set(), group.id),
      ...(shown.length < inGroup.size ? withoutMinor(group.id) : []), ...hide(minimum), "    autoLayout LeftRight", "  }"];
    if (shown.length < inGroup.size) {
      entries.push(allView(group.id));
      const all = thinned(id => inGroup.has(id), id => inGroup.has(id) ? id : drawnOutside(id), [...inGroup]);
      result.push("", `  view ${allView(group.id)} of ${group.id} {`, `    title ${quote(`${title} / everything`)}`, ...describe(thinNote(all)), "    include *", ...links([...inGroup].sort(byText), new Set(), group.id), ...hide(all), "    autoLayout LeftRight", "  }");
    }
    return result;
  };
  // The neighbourhood of one component: what it uses and what uses it. A hub with more neighbours than a view can show lists its
  // strongest and says how many were left out.
  const nearViews = () => draft.packages.flatMap(item => item.components.filter(entry => connected.has(entry.id)).flatMap(entry => {
    const own = packageOf.get(entry.id);
    const drawn = (id: string) => id === entry.id ? id : packageOf.get(id) === own ? id : packageOf.get(id);
    const strength = new Map<string, number>();
    for (const edge of draft.relationships) {
      const other = edge.from === entry.id ? edge.to : edge.to === entry.id ? edge.from : undefined, node = other && drawn(other);
      if (node) strength.set(node, (strength.get(node) ?? 0) + edge.imports);
    }
    const neighbours = [...strength.keys()].sort((a, b) => strength.get(b)! - strength.get(a)! || byText(a, b));
    const title = quote(`${draft.flat ? "" : `${item.title} / `}${entry.title}`);
    if (neighbours.length <= viewCap) {
      const minimum = thinned(id => id === entry.id, drawn, [entry.id]);
      return ["", `  view ${nearView(entry.id)} of ${entry.id} {`, `    title ${title}`, ...describe(`What ${entry.title} uses and what uses it.`, thinNote(minimum)), "    include *", ...hide(minimum), "    autoLayout LeftRight", "  }"];
    }
    const kept = neighbours.slice(0, viewCap), keptSet = new Set([entry.id, ...kept]);
    const shown = (minimum: number) => new Set(draft.relationships.filter(edge => edge.imports >= minimum).flatMap(edge => { const a = drawn(edge.from), b = drawn(edge.to); return a && b && a !== b && keptSet.has(a) && keptSet.has(b) ? [`${a}\0${b}`] : []; })).size;
    const minimum = thinning(keptSet.size, shown);
    // Listed by name rather than scoped (excluding names inside a scoped view resolves them against the scope first); a viewer finds the
    // subject of such a view from its id, `<component>_near`.
    return ["", `  view ${nearView(entry.id)} {`, `    title ${title}`, ...describe(`What ${entry.title} uses and what uses it: the ${viewCap} strongest of ${neighbours.length} neighbours.`, thinNote(minimum)), `    include ${entry.id}`, ...kept.map(id => `    include ${id}`), ...hide(minimum), "    autoLayout LeftRight", "  }"];
  }));
  const proofNote = (proof: readonly { complete: boolean }[]) => proof.some(item => !item.complete) ? "Each member is shown with the shortest way back to itself; only the strongest lines are drawn, the rest are in the model." : "Each member is shown with the shortest way back to itself.";
  const hidden = (count: number, all: string) => count ? `${plural(count, "smaller one")} ${count === 1 ? "is" : "are"} not shown here; ${all} lists everything.` : undefined;
  const places = placesOf(draft);
  const foldered = new Set(draft.packages.flatMap(item => item.components.filter(entry => entry.folder).map(entry => entry.id)));
  // A component inside an opened folder is drawn on the folder (or the child of it that holds it); it is hidden only when that box is.
  const gone = (drawn: (id: string) => string | undefined) => (id: string) => foldered.has(id) ? minor.has(drawn(id) ?? "") : minor.has(id);
  const readIn = (files: readonly string[]) => files.filter(path => !unread.has(path)).length;
  const filesUnder = (item: DraftPackage, id?: string) => item.components.filter(entry => !id || entry.id.startsWith(`${id}.`)).flatMap(entry => entry.files);
  /** An opened folder's own view, drawn as a package's is, with its strongest children as cards and the rest in its "everything" view. */
  const folderViews = (item: DraftPackage, folder: DraftFolder) => {
    const scope = places.chain(folder.id), drawn = places.drawnIn(scope);
    const inside = (id: string) => places.chain(id).includes(folder.id) && id !== folder.id;
    const { members, groups, folders } = childrenOf(item, folder.id);
    const shown = members.filter(id => !minor.has(id));
    const thin = shown.length < members.length;
    const drawnShown = (id: string) => { const node = drawn(id); return node && thin && minor.has(node) ? undefined : node; };
    const minimum = thinned(inside, drawnShown, [...shown, ...groups]);
    const holder = folder.parent ? item.folders.find(other => other.id === folder.parent)! : undefined;
    const why = folder.opened
      ? `Opened by the draft: it holds ${readIn(filesUnder(item, folder.id)).toLocaleString("en-US")} of the ${readIn(filesUnder(item, holder?.id)).toLocaleString("en-US")} files the scan reads in ${holder ? holder.title : draft.flat ? "the workspace" : item.title}.`
      : "Opened by a split in the overlay.";
    const result = ["", `  view ${componentsView(folder.id)} of ${folder.id} {`, `    title ${quote(folder.title)}`, ...describe(why, hidden(members.length - shown.length, allView(folder.id)), thinNote(minimum)), "    include *",
      ...links(shown, new Set(folders), folder.id), ...links(groups, new Set(groups), folder.id), ...(thin ? withoutMinor(folder.id) : []), ...hide(minimum), "    autoLayout LeftRight", "  }"];
    if (thin) {
      entries.push(allView(folder.id));
      const all = thinned(inside, drawn, [...members, ...groups]);
      result.push("", `  view ${allView(folder.id)} of ${folder.id} {`, `    title ${quote(`${folder.title} / everything`)}`, ...describe(why, thinNote(all)), "    include *", ...links(members, new Set(folders), folder.id), ...links(groups, new Set(groups), folder.id), ...hide(all), "    autoLayout LeftRight", "  }");
    }
    for (const group of item.groups.filter(candidate => candidate.folder === folder.id)) result.push(...groupView(item, group, places.drawnIn(places.chain(group.id)), `${folder.title} / ${group.title}`));
    return result;
  };

  if (draft.flat) {
    const item = draft.packages[0]!;
    const drawn = places.drawnIn([]);
    const { members: top, groups, folders } = childrenOf(item);
    const shown = top.filter(id => !minor.has(id)), hiddenHere = gone(drawn);
    const drawnShown = (id: string) => hiddenHere(id) ? undefined : drawn(id);
    const minimum = thinned(() => true, drawnShown, [...shown, ...groups]);
    out.push("  view index {", "    title 'Components'", ...describe(hidden(top.length - shown.length, "all_components"), thinNote(minimum)), "    include *", ...links(shown, new Set(folders)), ...links(groups, new Set(groups)), ...(top.length > shown.length ? ["    exclude * where tag is #minor"] : []), ...notBehavior, ...hide(minimum), "    autoLayout LeftRight", "  }");
    if (top.length > shown.length) {
      entries.push("all_components");
      const all = thinned(() => true, drawn, [...top, ...groups]);
      out.push("", "  view all_components {", "    title 'All components'", ...describe(thinNote(all)), "    include *", ...links(top, new Set(folders)), ...links(groups, new Set(groups)), ...notBehavior, ...hide(all), "    autoLayout LeftRight", "  }");
    }
    for (const group of item.groups.filter(candidate => !candidate.folder)) out.push(...groupView(item, group, drawn));
    for (const folder of item.folders) out.push(...folderViews(item, folder));
    if (analysis.componentCycles.size) {
      entries.push("cycles");
      const found = [...analysis.componentCycles.values()].flat();
      const proof = found.map(loop => witness(loop, draft.relationships));
      out.push("", "  view cycles {", "    title 'Import cycles'", ...describe(`${loopNote(found)} Components that import each other in a loop.`, proofNote(proof)), ...proof.flatMap(item => item.edges.map(edge => `    include ${edge.from} -> ${edge.to}`)), "    autoLayout LeftRight", "  }");
    }
  } else {
    const shownPackages = draft.packages.filter(item => !minor.has(item.id));
    const across = (ids: ReadonlySet<string>) => (n: number) => new Set(draft.relationships.filter(edge => edge.imports >= n).flatMap(edge => { const a = packageOf.get(edge.from), b = packageOf.get(edge.to); return a && b && a !== b && ids.has(a) && ids.has(b) ? [`${a}\0${b}`] : []; })).size;
    const include = (items: readonly DraftPackage[]) => items.flatMap(item => [`    include ${item.id} with {`, `      navigateTo ${componentsView(item.id)}`, "    }"]);
    const apart = thinning(shownPackages.length, across(new Set(shownPackages.map(item => item.id))));
    out.push("  view index {", "    title 'Packages'", ...describe(hidden(draft.packages.length - shownPackages.length, "all_packages"), thinNote(apart)), ...include(shownPackages), ...hide(apart), "    autoLayout LeftRight", "  }");
    if (shownPackages.length < draft.packages.length) {
      entries.push("all_packages");
      const everything = thinning(draft.packages.length, across(new Set(draft.packages.map(item => item.id))));
      out.push("", "  view all_packages {", "    title 'All packages'", ...describe(thinNote(everything)), ...include(draft.packages), ...hide(everything), "    autoLayout LeftRight", "  }");
    }
    if (analysis.packageCycles.length) {
      entries.push("cycles");
      // Between packages a line is the sum of the imports under it.
      const lines = new Map<string, { from: string; to: string; imports: number }>();
      for (const edge of draft.relationships) {
        const from = packageOf.get(edge.from), to = packageOf.get(edge.to);
        if (from && to && from !== to) { const key = `${from}\0${to}`; lines.set(key, { from, to, imports: (lines.get(key)?.imports ?? 0) + edge.imports }); }
      }
      const proof = analysis.packageCycles.map(loop => witness(loop, [...lines.values()]));
      out.push("", "  view cycles {", "    title 'Package cycles'", ...describe(`${loopNote(analysis.packageCycles)} Packages that import each other in a loop.`, proofNote(proof)), ...proof.flatMap(item => item.edges.map(edge => `    include ${edge.from} -> ${edge.to}`)), "    autoLayout LeftRight", "  }");
    }
    for (const item of draft.packages) {
      const own = new Set(item.components.map(entry => entry.id));
      const drawn = places.drawnIn([item.id]);
      const { members: top, groups, folders } = childrenOf(item);
      const shown = top.filter(id => !minor.has(id)), hiddenHere = gone(drawn);
      const drawnShown = (id: string) => hiddenHere(id) || minor.has(packageOf.get(id) ?? "") ? undefined : drawn(id);
      const minimum = thinned(id => own.has(id), drawnShown, [...shown, ...groups]);
      out.push("", `  view ${componentsView(item.id)} of ${item.id} {`, `    title ${quote(item.title)}`, ...describe(hidden(top.length - shown.length, allView(item.id)), thinNote(minimum)), "    include *", ...links(shown, new Set(folders), item.id), ...links(groups, new Set(groups), item.id),
        ...(top.length > shown.length || draft.packages.some(other => minor.has(other.id)) ? withoutMinor(item.id) : []), ...hide(minimum), "    autoLayout LeftRight", "  }");
      if (top.length > shown.length) {
        entries.push(allView(item.id));
        const all = thinned(id => own.has(id), drawn, [...top, ...groups]);
        out.push("", `  view ${allView(item.id)} of ${item.id} {`, `    title ${quote(`${item.title} / everything`)}`, ...describe(thinNote(all)), "    include *", ...links(top, new Set(folders), item.id), ...links(groups, new Set(groups), item.id), ...hide(all), "    autoLayout LeftRight", "  }");
      }
      for (const group of item.groups.filter(candidate => !candidate.folder)) out.push(...groupView(item, group, drawn));
      for (const folder of item.folders) out.push(...folderViews(item, folder));
      if (analysis.componentCycles.has(item.id)) {
        entries.push(cyclesView(item.id));
        const proof = analysis.componentCycles.get(item.id)!.map(loop => witness(loop, draft.relationships));
        out.push("", `  view ${cyclesView(item.id)} {`, `    title ${quote(`${item.title} / import cycles`)}`, ...describe(`${loopNote(analysis.componentCycles.get(item.id)!)} Components that import each other in a loop.`, proofNote(proof)), ...proof.flatMap(entry => entry.edges.map(edge => `    include ${edge.from} -> ${edge.to}`)), "    autoLayout LeftRight", "  }");
      }
    }
  }
  out.push(...nearViews(), "}", "");
  return { text: out.join("\n"), entries };
}

/** The human decisions in an overlay, one comparable line each. */
const pinsOf = (overlay: Overlay | undefined) => new Map<string, string>([
  ...Object.entries(overlay?.elements ?? {}).filter(([, entry]) => entry.by === "human").map(([key, entry]) => [`element '${key}'`, JSON.stringify(entry)] as const),
  ...(overlay?.merges ?? []).filter(item => item.by === "human").map(item => [`merge '${item.title}'`, JSON.stringify(item)] as const),
  ...(overlay?.splits ?? []).filter(item => item.by === "human").map(item => [`split '${item.key}'`, JSON.stringify(item)] as const),
  ...(overlay?.relationships ?? []).filter(item => item.by === "human").map(item => [`relationship '${item.from}' → '${item.to}'`, JSON.stringify(item)] as const),
]);

/** Human pins that were in the last commit's overlay and are now different or gone. Nothing is enforced: the person decides whether the change is theirs. */
export const changedPins = (committed: Overlay | undefined, current: Overlay | undefined) => {
  const now = pinsOf(current);
  return [...pinsOf(committed)].filter(([name, text]) => now.get(name) !== text).map(([name]) => `${name} (pinned by a human) differs from the last commit or is gone`);
};

/** Where `draft` records each element's overlay key (id → key), for the viewer's name and map editing. */
export const keysPath = join(".cache", "pathlight", "keys.json");

/**
 * Names and notes for a draft, kept apart from the generated model so a rerun never loses them. Each entry is keyed by what the code is (the
 * package directory, the folder path, the file path, or `<directory>#small` / `<directory>#loose` for a collection), not by the generated id, so
 * it keeps applying when an id changes. An entry whose key matches nothing is reported, never silently kept.
 */
const Words = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max), Schema.isPattern(/^[^\x00-\x1f\x7f]+$/));
const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024), Schema.isPattern(/^[^\x00-\x1f\x7f]+$/));
/** Who made the decision. A `human` entry is a pin: tools and agents leave it alone, and `draft` reports one that differs from the last commit. */
const By = Schema.optionalKey(Schema.Literals(["human", "agent"]));
export const Overlay = Schema.Struct({
  version: Schema.Literal(1),
  elements: Schema.Record(Key, Schema.Struct({ title: Schema.optionalKey(Words(60)), note: Schema.optionalKey(Words(300)), by: By })).check(Schema.isMaxProperties(4096)),
  /** Folders (by path) that are really one component, drawn as one top-level component with this title. */
  merges: Schema.optionalKey(Schema.Array(Schema.Struct({ title: Words(60), keys: Schema.Array(Key).check(Schema.isMinLength(2), Schema.isMaxLength(32)), by: By })).check(Schema.isMaxLength(256))),
  /** A folder (by path) that is several: one component per subfolder, and one for the files directly in it. */
  splits: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Key, by: By })).check(Schema.isMaxLength(256))),
  /** A label for a relationship that imports already support (the count stays in its description). */
  relationships: Schema.optionalKey(Schema.Array(Schema.Struct({ from: Key, to: Key, title: Words(60), by: By })).check(Schema.isMaxLength(1024))),
});
export interface Overlay extends Schema.Schema.Type<typeof Overlay> {}

/** Applies an overlay to a draft. Titles and notes change; ids, files, globs and relationships never do. `unknown` lists keys that matched nothing. */
export function applyOverlay(draft: Draft, overlay: Overlay): { draft: Draft; unknown: string[] } {
  const used = new Set<string>();
  const over = <T extends { key: string; title: string; note?: string }>(item: T): T => {
    const entry = overlay.elements[item.key];
    if (!entry) return item;
    used.add(item.key);
    return { ...item, ...(entry.title ? { title: entry.title } : {}), ...(entry.note ? { note: entry.note } : {}) };
  };
  const packages = draft.packages.map(item => ({ ...over(item), components: item.components.map(over), groups: item.groups.map(over), folders: item.folders.map(over) }));
  return { draft: { ...draft, packages }, unknown: Object.keys(overlay.elements).filter(key => !used.has(key)).sort() };
}

/** The name another language's manifest gives its package: a Go module (its last path segment), a Rust crate, a Python project. */
const otherManifests: Record<string, (text: string) => string | undefined> = {
  "go.mod": text => /^module\s+(\S+)/m.exec(text)?.[1]?.split("/").at(-1),
  "Cargo.toml": text => /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(text)?.[1],
  "pyproject.toml": text => /^\[(?:project|tool\.poetry)\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(text)?.[1],
};

/**
 * The manifests of a workspace that name a package: where one package ends and the next begins. `package.json` first; a Go module, Rust crate or
 * Python project is a package too, so code in another language is drawn as its own package rather than as a folder of whatever package holds it.
 */
export const readManifests = Effect.fn("Draft.manifests")(function* (root: string, paths: readonly string[]) {
  const manifests: { directory: string; name: string }[] = [];
  const directoryOf = (path: string) => posix.dirname(path) === "." ? "" : posix.dirname(path);
  for (const path of paths.filter(item => basename(item) === "package.json" && !item.includes("node_modules/"))) {
    const parsed = yield* io("Draft.manifest", () => readFile(join(root, path), "utf8")).pipe(Effect.flatMap(json), Effect.option);
    const value = parsed._tag === "Some" && parsed.value && typeof parsed.value === "object" ? parsed.value as Record<string, unknown> : undefined;
    if (value && typeof value.name === "string") manifests.push({ directory: directoryOf(path), name: value.name });
  }
  for (const path of paths.filter(item => basename(item) in otherManifests && !item.includes("node_modules/"))) {
    if (manifests.some(item => item.directory === directoryOf(path))) continue;
    const text = yield* io("Draft.manifest", () => readFile(join(root, path), "utf8")).pipe(Effect.option);
    const name = text._tag === "Some" ? otherManifests[basename(path)]!(text.value) : undefined;
    if (name) manifests.push({ directory: directoryOf(path), name });
  }
  return manifests;
});

/**
 * The drawn files the scan could not read, by language ("32 Zig, 7 Go files"), or "" when there are none: the boxes are there, the arrows to and
 * from them are not, and a person must be told so rather than read a quiet picture as complete.
 */
export function unreadSummary(draft: Draft, unread: ReadonlySet<string>) {
  const counts = new Map<string, number>();
  for (const path of draft.packages.flatMap(item => item.components.flatMap(entry => entry.files)).filter(path => unread.has(path))) counts.set(languageOf(path), (counts.get(languageOf(path)) ?? 0) + 1);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return total ? `${[...counts].sort(([a, x], [b, y]) => y - x || byText(a, b)).map(([language, count]) => `${count} ${language}`).join(", ")} ${total === 1 ? "file" : "files"}` : "";
}

/** Line counts of the files the scan does not read, which it therefore did not count. */
export const unreadLines = Effect.fn("Draft.unreadLines")(function* (root: string, unread: readonly string[]) {
  const counted = yield* Effect.forEach(unread, path => io("Draft.lines", () => readFile(join(root, path), "utf8")).pipe(
    Effect.map(text => [[path, text.split("\n").length - (text.endsWith("\n") ? 1 : 0)] as const]), Effect.catch(() => Effect.succeed([]))), { concurrency: 16 });
  return counted.flat();
});

/** True when a LikeC4 file's `specification` block declares `tag behavior`, as the behavior skill's state diagrams do. */
export const declaresBehavior = (text: string) => {
  for (const match of text.matchAll(/(?:^|\s)specification\s*\{/g)) {
    let depth = 1, at = match.index + match[0].length;
    for (; at < text.length && depth > 0; at++) depth += text[at] === "{" ? 1 : text[at] === "}" ? -1 : 0;
    if (/(?:^|[\s{])tag\s+behavior\b/.test(text.slice(match.index + match[0].length, at - 1))) return true;
  }
  return false;
};

export const draftWorkspace = Effect.fn("Draft.workspace")(function* (workspace: string, options: { out?: string; force?: boolean } = {}) {
  const root = resolve(workspace);
  // Written into `.pathlight/` unless told where; the ignored state (the overlay keys) stays under the workspace's own `.cache`.
  const target = resolve(options.out ?? join(workspace, home));
  const state = options.out ? target : root;
  const scan = yield* scanWorkspace(root);
  const { paths } = yield* listFiles(root);
  const manifests = yield* readManifests(root, paths);
  const overlayText = yield* io("Draft.overlay", () => readFile(join(target, overlayFile), "utf8")).pipe(Effect.option);
  const overlay = overlayText._tag === "Some" ? yield* Schema.decodeUnknownEffect(Overlay, { onExcessProperty: "error" })(yield* json(overlayText.value)) : undefined;
  const committedText = overlay ? yield* run("git", ["-C", target, "show", `HEAD:./${overlayFile}`]).pipe(Effect.option) : undefined;
  const committed = committedText?._tag === "Some" ? yield* Schema.decodeUnknownEffect(Overlay)(yield* json(committedText.value)).pipe(Effect.option) : undefined;
  const unread = paths.filter(isUnscannedSource);
  const base = draftOf(scan, manifests, overlay, unread);
  const { draft, unknown } = overlay ? applyOverlay(base, overlay) : { draft: base, unknown: [] as string[] };
  // Boxes of unread code alone would be a picture with no arrows at all: the draft needs some code the scan reads.
  const unreadSet = new Set(unread);
  if (!draft.packages.some(item => item.components.some(entry => entry.files.some(path => !unreadSet.has(path))))) {
    return yield* Effect.fail(failure("Draft.empty", `No source in a language the scan reads (${scannedLanguages}) was found to draw.`));
  }

  // A model you wrote is never rewritten: only a previous draft (marked as generated) is replaced.
  const existing = yield* io("Draft.existing", () => readdir(target)).pipe(Effect.catch(() => Effect.succeed([] as string[])));
  // `*.behavior.c4` files are state diagrams an agent wrote beside the draft; a rerun leaves them alone.
  const others = existing.filter(name => /\.(c4|likec4)$/.test(name) && name !== modelFile && !/\.behavior\.(c4|likec4)$/.test(name));
  const previous = yield* io("Draft.previous", () => readFile(join(target, modelFile), "utf8")).pipe(Effect.option);
  const hasMapping = existing.includes(mappingFile);
  if (!options.force && (others.length || (previous._tag === "Some" && !previous.value.startsWith(generatedMarker)) || (hasMapping && previous._tag === "None"))) {
    return yield* Effect.fail(failure("Draft.exists", `${target} already has a LikeC4 model or file mapping that was not generated by pathlight draft. It is never rewritten. Use --out DIR to write the draft elsewhere.`));
  }
  const label = basename(options.out ? target : root);
  // A config that is already there names the project, so a map copied to a folder of another name still matches it.
  const config = existing.includes(configFile) ? yield* io("Draft.config", () => readFile(join(target, configFile), "utf8")).pipe(Effect.flatMap(json), Effect.option) : undefined;
  const configName = config?._tag === "Some" && config.value && typeof config.value === "object" ? (config.value as Record<string, unknown>).name : undefined;
  const name = typeof configName === "string" && configName ? configName : slug(label);
  const lines = new Map([...scan.files.map(file => [file.path, file.lines] as const), ...yield* unreadLines(root, unread)]);
  // Only a state diagram declares `tag behavior`; a journey from `flow add` does not, and naming a tag no file declares stops the model compiling.
  const behaviorTexts = yield* Effect.forEach(existing.filter(name => /\.behavior\.(c4|likec4)$/.test(name)), name => io("Draft.behavior", () => readFile(join(target, name), "utf8")).pipe(Effect.catch(() => Effect.succeed(""))));
  const rendered = renderDraft(draft, lines, behaviorTexts.some(declaresBehavior), unreadSet);
  const mappings = draft.packages.flatMap(item => item.components.flatMap(entry => entry.globs.map(glob => ({ glob, element: entry.id }))));
  yield* io("Draft.write", async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, modelFile), rendered.text);
    await writeFile(join(target, mappingFile), `${JSON.stringify({ version: 1, project: name, mappings, ...(draft.ignore.length ? { ignore: draft.ignore } : {}), ...(rendered.entries.length ? { entries: rendered.entries } : {}) }, null, 2)}\n`);
    await mkdir(join(state, ".cache", "pathlight"), { recursive: true });
    await writeFile(join(state, keysPath), `${JSON.stringify({ version: 1, keys: Object.fromEntries(draft.packages.flatMap(item => [...(draft.flat ? [] : [[item.id, item.key] as const]), ...item.folders.map(folder => [folder.id, folder.key] as const), ...item.groups.map(group => [group.id, group.key] as const), ...item.components.map(entry => [entry.id, entry.key] as const)])) })}\n`);
    if (!existing.includes(configFile)) await writeFile(join(target, configFile), `${JSON.stringify({ $schema: "https://likec4.dev/schemas/config.json", name, title: label }, null, 2)}\n`);
  });
  const components = draft.packages.reduce((sum, item) => sum + item.components.length, 0), collections = draft.packages.reduce((sum, item) => sum + item.groups.length, 0);
  const folders = draft.packages.reduce((sum, item) => sum + item.folders.length, 0);
  return { target, project: name, packages: draft.flat ? 0 : draft.packages.length, components, collections, folders, elements: components + collections + folders + (draft.flat ? 0 : draft.packages.length),
    relationships: draft.relationships.length, mappings: mappings.length, ignored: draft.ignored, unread: unreadSummary(draft, unreadSet), overlay: overlay ? Object.keys(overlay.elements).length - unknown.length : 0, unknown,
    problems: draft.problems, pins: overlay && committed?._tag === "Some" ? changedPins(committed.value, overlay) : [] };
});
