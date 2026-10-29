import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, mappingIn } from "./effects";

// Parcel with a journey (a dynamic view whose last step has no relationship behind it) and, optionally, a state diagram an agent wrote.
const workspace = async (behavior: boolean) => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-mode-"));
  await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
  await writeFile(join(directory, "views.c4"), `${await readFile(join(directory, "views.c4"), "utf8")}
views {
  dynamic view placeorder {
    title 'Placing an order'
    description 'Synced at abc1234.'
    customer -> parcel.storefront 'opens checkout'
    parcel.storefront -> parcel.commerce.api 'submits the cart'
    parcel.commerce.api -> parcel.commerce.inventory 'reserves stock'
    parcel.commerce.api -> parcel.commerce.orders 'commits the order'
    parcel.commerce.orders -> parcel.fulfillment.shipping 'tells shipping directly'
  }
}
`);
  await mkdir(join(directory, "src/api"), { recursive: true }); await mkdir(join(directory, "src/web"), { recursive: true });
  await writeFile(join(directory, "src/api/checkout.ts"), "x\n"); await writeFile(join(directory, "src/web/store.ts"), "x\n");
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "parcel", mappings: [
    { glob: "src/api/**", element: "parcel.commerce.api" }, { glob: "src/web/**", element: "parcel.storefront" }] }));
  if (behavior) await writeFile(join(directory, "checkout.behavior.c4"), `specification {
  element flow
  element state
  tag behavior
  tag bug
}
model {
  checkoutflow = flow 'Checking out' {
    #behavior
    cart = state 'They see their cart' { description 'src/web/store.ts' }
    twice = state 'They are charged twice' { #bug
      description 'A retry races the first request. src/api/checkout.ts' }
    cart -> twice 'retries while it is saving'
  }
}
views {
  view checkoutflow of checkoutflow {
    title 'What happens at checkout'
    description 'Synced at abc1234.'
    include *
    autoLayout TopBottom
  }
}
`);
  return directory;
};

test("F traces a flow on the diagram: numbered steps, a reader in the inspector, the step with no relationship says so, and esc leaves", async () => {
  const directory = await workspace(true);
  const socket = join("/tmp", `c4fm-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "flow", "-x", "170", "-y", "42", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "services", "--workspace", directory, "--project", "parcel", "--select", "customer");
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 160; attempt++) {
        output = await screen();
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    // Flows are read after the first frame; the card says so when the selected component is in one.
    const before = await until(text => text.includes("In flows") && text.includes("◇ Placing an order"), "the In flows card");
    expect(before).toContain("◇ reading");
    expect(before).not.toContain("Steps");

    await tmux("send-keys", "-t", pane, "F");
    const first = await until(text => /^ flow /m.test(text) && text.includes("1/5") && text.includes("opens checkout"), "flow mode on step 1");
    expect(first).toContain("a reading of the code, not observed");
    expect(first).toContain("Selected: parcel.storefront");
    expect(first).toContain("▶");
    expect(first).not.toContain("Connects");
    // Each step lands on its component, the card says which step, and a hop with no relationship says so only where it is read.
    await tmux("send-keys", "-t", pane, "]");
    const second = await until(text => text.includes("Selected: parcel.commerce.api") && text.includes("2/5"), "step 2");
    expect(second).toMatch(/─ 2 /);
    expect(second).not.toContain("≠");
    await tmux("send-keys", "-t", pane, "]", "]", "]");
    const last = await until(text => text.includes("Selected: parcel.fulfillment.shipping") && text.includes("5/5"), "step 5");
    expect(last).toContain("≠ no relationship in the model");
    // Esc leaves flow mode and brings back the connections.
    await tmux("send-keys", "-t", pane, "Escape");
    const left = await until(text => /^ diagram /m.test(text) && text.includes("Connects"), "diagram mode");
    expect(left).not.toContain("Steps");

    // The next F is the other flow, a state diagram: its bug mark shows in the reader.
    await tmux("send-keys", "-t", pane, "F", "F");
    await until(text => /^ flow /m.test(text) && text.includes("They see their cart"), "the state diagram");
    await tmux("send-keys", "-t", pane, "]");
    expect(await until(text => text.includes("marked as broken in the diagram"), "the bug mark")).toContain("They are charged twice");
    // After the last flow, F leaves.
    await tmux("send-keys", "-t", pane, "F");
    await until(text => /^ diagram /m.test(text), "left after the last flow");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("a flow is shown on the screen as text, so an agent can check it", async () => {
  const directory = await workspace(false);
  try {
    const out = join(directory, "screen.txt");
    await run("sh", ["-c", `"$1" "$2" see services --workspace "$3" --project parcel --cols 150 --rows 36 --keys 'F,],]' > "$4"`, "sh", process.execPath, resolve("src/cli.ts"), directory, out]);
    const screen = await readFile(out, "utf8");
    const file = "tests/golden/flow-150x36.txt";
    if (process.env.UPDATE_GOLDEN === "1") { await mkdir("tests/golden", { recursive: true }); await writeFile(file, screen); return; }
    expect(screen).toBe(await readFile(file, "utf8"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("F keeps the fitted camera, and a hop with no connector has its gap drawn, dotted in the agent's colour", async () => {
  const directory = await workspace(false);
  try {
    const see = async (keys: string[], ansi = false) => {
      const out = join(directory, `screen-${keys.length}-${ansi}.txt`);
      await run("sh", ["-c", `"$1" "$2" see services --workspace "$3" --project parcel --cols 150 --rows 36 --select customer ${keys.length ? `--keys '${keys.join(",")}'` : ""} ${ansi ? "--ansi" : ""} > "$4"`, "sh", process.execPath, resolve("src/cli.ts"), directory, out]);
      return readFile(out, "utf8");
    };
    // Entering flow mode on a fitted view moves nothing: the same zoom, and every card where it was.
    const plain = await see([]), flow = await see(["F"]);
    const zoom = (text: string) => /zoom \d+%/.exec(text)?.[0];
    expect(zoom(flow)).toBe(zoom(plain));
    // Only the diagram's columns: the step reader names the same components.
    const at = (text: string, label: string) => { const rows = text.split("\n").map(line => line.slice(0, 100)); const row = rows.findIndex(line => line.includes(label)); return [row, rows[row]?.indexOf(label)]; };
    for (const label of ["Storefr", "Inventory", "Payment"]) expect(at(flow, label)).toEqual(at(plain, label));
    // The step orders → shipping has no relationship: its gap is the only dotted run in the agent's violet (#7466b0).
    const violetDots = (text: string) => (text.match(/38;2;116;102;176[^m]*m[┈┊]/g) ?? []).length;
    expect(violetDots(await see([], true))).toBe(0);
    expect(violetDots(await see(["F"], true))).toBeGreaterThan(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
  // At 100×30 the fixture's cards reach the canvas edges (Agent adapters at column 2, Persistent viewer three from the right). Neither F nor a step
  // to the card at the edge moves any card: a fitted view has every card on screen.
  const fixture = await mkdtemp(join(tmpdir(), "pathlight-flow-edge-"));
  try {
    await cp("tests/fixtures/viewer", fixture, { recursive: true });
    await writeFile(join(fixture, "model.c4"), `${await readFile(join(fixture, "model.c4"), "utf8")}
views {
  dynamic view opening {
    title 'Opening a view'
    plugin -> launcher 'opens a view'
    launcher -> viewer 'starts the pane'
  }
}
`);
    const corners = async (keys: string) => {
      const screen = await run(process.execPath, [resolve("src/cli.ts"), "see", "live", "--workspace", fixture, "--cols", "100", "--rows", "30", "--select", "plugin", `--keys=${keys}`]);
      return screen.split("\n").flatMap((line, row) => [...line.matchAll(/╭─/g)].map(match => `${row}:${match.index}`));
    };
    const plain = await corners("");
    expect(plain).toContain("15:2");
    expect(await corners("F")).toEqual(plain);
    expect(await corners("F,]")).toEqual(plain);
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 90_000);

test("e on a step that names a function opens it in the editor at the line the file declares it on now", async () => {
  const directory = await workspace(false);
  const socket = join("/tmp", `c4fe-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await writeFile(join(directory, "views.c4"), (await readFile(join(directory, "views.c4"), "utf8")).replace("'submits the cart'",
      "'submits the cart' {\n      notes 'submitCart | src/api/checkout.ts | export function submitCart(cart: Cart)'\n    }"));
    // Moved down since the flow was written: the editor must land on where it is now.
    await writeFile(join(directory, "src/api/checkout.ts"), "import x from './x';\n\n// Takes the cart.\nexport function submitCart(cart: Cart) {}\n");
    // A stand-in editor named nvim, so the viewer passes it a line; it records what it was given.
    await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "bin/nvim"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "editor-args")}"\n`, { mode: 0o755 });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "flow", "-x", "170", "-y", "42", "-P", "-F", "#{pane_id}",
      "env", `VISUAL=${join(directory, "bin/nvim")}`, process.execPath, resolve("src/cli.ts"), "view", "services", "--workspace", directory, "--project", "parcel", "--select", "customer");
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 160; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(text => text.includes("◇ Placing an order"), "the flow");
    await tmux("send-keys", "-t", pane, "F", "]");
    expect(await until(text => text.includes("2/5") && text.includes("ƒ submitCart"), "step 2 with its function")).toContain("e read it");
    await tmux("send-keys", "-t", pane, "e");
    await until(text => text.includes("Returned from submitCart"), "back from the editor");
    expect((await readFile(join(directory, "editor-args"), "utf8")).trim().split("\n")).toEqual(["+4", join(await realpath(directory), "src/api/checkout.ts")]);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("F in a flow's own view starts with that flow, even when another flow also passes through the selected component", async () => {
  const directory = await workspace(true);
  try {
    // Another journey that sorts first and also passes through the storefront.
    await writeFile(join(directory, "views.c4"), `${await readFile(join(directory, "views.c4"), "utf8")}
views {
  dynamic view aaabrowse {
    title 'Browsing'
    description 'Synced at abc1234.'
    customer -> parcel.storefront 'looks at a parcel page'
    parcel.storefront -> parcel.commerce.api 'asks for the catalogue'
  }
}
`);
    const screen = await run(process.execPath, [resolve("src/cli.ts"), "see", "placeorder", "--workspace", directory, "--project", "parcel", "--cols", "150", "--rows", "40", "--select", "parcel.storefront", "--keys", "F"]);
    expect(screen).toContain("opens checkout");
    expect(screen).not.toContain("They see their cart");
    expect(screen).not.toContain("looks at a parcel page");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

// After `t` with draw it, the journey the agent writes is what the next F opens (not the first flow through the selection), its title is the toast,
// and the reload that brings it moves neither the camera nor the selection.
test("F opens the journey a t just drew, whatever the selection, and its arrival moves nothing", async () => {
  const directory = await workspace(false);
  const socket = join("/tmp", `c4fd-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "drawn", "-x", "300", "-y", "42", "-P", "-F", "#{pane_id}", "cat");
    const shown = JSON.parse(await run(process.execPath, [resolve("src/cli.ts"), "show", "services", "--workspace", directory,
      "--project", "parcel", "--pane", harness, "--socket", socket])) as { pane: string };
    const screen = (pane = shown.pane) => tmux("capture-pane", "-p", "-t", pane);
    const until = async (predicate: (text: string) => boolean, label: string, pane = shown.pane) => {
      let output = "";
      for (let attempt = 0; attempt < 200; attempt++) {
        output = await screen(pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(text => text.includes("In flows") && text.includes("◇ Placing an order"), "the first flow through the selection");
    await delay(700);
    const zoom = /zoom \d+%/.exec(await screen())?.[0];
    expect(zoom).toBeDefined();
    // The offered first question is a how-question: draw it is on, and Enter sends it.
    await tmux("send-keys", "-t", shown.pane, "t");
    await until(text => text.includes("Ask the agent") && text.includes("● draw it"), "the ask dialog with draw it on");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    await until(text => text.includes("have the path recorded as a pathlight journey"), "the question in the agent's pane", harness);
    const before = await until(text => !text.includes("Ask the agent"), "the dialog closed");
    const selection = /Selected: (\S+)/.exec(before)?.[1];
    expect(selection).toBeDefined();
    await writeFile(join(directory, "paying.behavior.c4"), `views {
  dynamic view paying {
    title 'Paying for an order'
    description 'Synced at abc1234.'
    parcel.commerce.api -> payments 'charges the card'
  }
}
`);
    const arrived = await until(text => text.includes("Drawn: Paying for an order · F walks it"), "the drawn toast");
    expect(arrived).toContain(`Selected: ${selection}`);
    expect(/zoom \d+%/.exec(arrived)?.[0]).toBe(zoom);
    await tmux("send-keys", "-t", shown.pane, "F");
    const opened = await until(text => /^ flow /m.test(text), "flow mode");
    expect(opened).toContain("◇ Paying for an order");
    expect(opened).toContain("charges the card");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
