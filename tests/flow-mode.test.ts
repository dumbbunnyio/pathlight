import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      process.execPath, resolve("src/cli.ts"), "view", "services", "--workspace", directory, "--project", "parcel");
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
    expect(before).not.toContain("2 Steps");

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
    expect(left).not.toContain("2 Steps");

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
