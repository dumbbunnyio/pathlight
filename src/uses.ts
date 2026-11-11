/**
 * How a file uses a name it imports, read from the syntax alone. The scan keeps the strongest use of each name. A drawn arrow means one box runs the
 * other's code or builds its values; a name used only in type positions does not make one (`docs/scan.md`, "Uses").
 *
 * - `calls`: `f(…)`, `X.method(…)`, a member called through a binding annotated with the imported type (`(db: Db) => db.query()`), a macro;
 * - `renders`: a JSX element (`<Button />`);
 * - `constructs`: `new X(…)`, a Go composite literal, a Rust struct literal;
 * - `extends`: a class's base, an embedded Go struct, a Rust `impl Trait for`;
 * - `references`: used as a value any other way (passed, stored, compared), and every case the reading cannot place, so a doubt keeps the arrow;
 * - `types`: only in type positions (annotations, signatures, generic arguments, `implements`).
 */
export type How = "calls" | "renders" | "constructs" | "extends" | "references" | "types";
export const hows: readonly How[] = ["calls", "renders", "constructs", "extends", "references", "types"];
const rank = new Map(hows.map((how, index) => [how, index] as const));
export const stronger = (a: How, b: How) => rank.get(a)! <= rank.get(b)! ? a : b;

/** One name a file uses from an import: `imported` is the name in the other file (to follow it through re-exports), `name` how it reads (`Document.findByPk`). */
export interface Use { readonly imported: string; readonly name: string; readonly how: How }

/** The strongest use of each name, strongest first, then by name. */
export function strongest(uses: Iterable<Use>): Use[] {
  const best = new Map<string, Use>();
  for (const use of uses) {
    const key = `${use.imported}\0${use.name}`, seen = best.get(key);
    if (!seen || stronger(use.how, seen.how) === use.how && use.how !== seen.how) best.set(key, use);
  }
  return [...best.values()].sort((a, b) => rank.get(a.how)! - rank.get(b.how)! || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether an import carries code across: anything but an import whose every use is in a type position. An import with no uses read (a side-effect
 * import, `require`, a dynamic import, a name never used) carries code unless it is written as a type import, since nothing says it does not.
 */
export const carriesCode = (item: { readonly kind: string; readonly uses?: readonly { readonly how: How }[] }) =>
  item.uses?.length ? item.uses.some(use => use.how !== "types") : item.kind !== "type";

/**
 * Uses from a file's occurrences of its bindings. Each binding is a local name for something imported: a name (`imported`), or a whole module
 * (`namespace`, whose members are the names used). A member called through a local annotated with an imported type counts as a call of that type.
 */
export interface Binding { readonly local: string; readonly imported: string; readonly namespace: boolean; readonly typeOnly: boolean }
export interface Occurrence { readonly local: string; readonly member?: string; readonly how: How; readonly through?: true }

export function usesOf(binding: Binding, occurrences: readonly Occurrence[]): Use[] {
  const found: Use[] = [];
  for (const item of occurrences) {
    if (item.local !== binding.local) continue;
    // `import type { Db }` still carries code when a member is called through a local it annotates.
    const how = binding.typeOnly && !item.through ? "types" : item.how;
    // A module used whole (`createDatabase(models)`) is a use of all of it.
    if (binding.namespace) found.push(item.member ? { imported: item.member, name: item.member, how } : { imported: "*", name: binding.local, how });
    else found.push({ imported: binding.imported, name: item.member && how === "calls" ? `${binding.local}.${item.member}` : binding.local, how });
  }
  return strongest(found);
}

/** Calls through typed locals: `typed` maps a local (`db`) to the bindings its annotation names (`Db`); `called` the members called on each local. */
export function callsThrough(typed: ReadonlyMap<string, ReadonlySet<string>>, called: ReadonlyMap<string, ReadonlySet<string>>): Occurrence[] {
  const found: Occurrence[] = [];
  for (const [local, types] of typed) for (const member of called.get(local) ?? []) for (const type of types) found.push({ local: type, member, how: "calls", through: true });
  return found;
}
