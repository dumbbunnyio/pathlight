import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { mapMessage } from "../src/ask";
import { run, mappingIn, overlayIn } from "./effects";

test("a map request names the overlay key, carries the rules and no control characters", () => {
  const text = mapMessage({ title: "Loose\x1b[31m files", id: "demo.loose", key: ".#loose", files: ["a.ts"], links: ["→ Core"] }, "what are\nthese?");
  expect(text).toContain('"Loose [31m files" component (demo.loose): what are these? [overlay key: .#loose; files: a.ts; connects: → Core]');
  expect(text).toContain('"by":"agent"');
  expect(text).toContain("wait for my yes");
  expect(text).not.toMatch(/[\x00-\x1f\x7f]/);
});

test("n pins a name and note from the viewer, m asks the agent to improve the map, both for a generated draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-map-edit-"));
  const socket = join("/tmp", `c4m-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "demo" }));
    for (const folder of ["billing", "orders", "stock"]) {
      await mkdir(join(directory, "src", folder), { recursive: true });
      for (const file of ["a", "b", "c", "d"]) await writeFile(join(directory, "src", folder, `${file}.ts`), folder === "orders" ? `import "../billing/a";\nimport "../stock/a";\nexport const v = 1;\n` : "export const v = 1;\n");
    }
    await cli("draft", "--workspace", directory);
    expect(JSON.parse(await readFile(join(directory, ".cache/pathlight/keys.json"), "utf8")).keys).toMatchObject({ billing: "src/billing" });
    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "map-edit", "-x", "170", "-y", "44", "-P", "-F", "#{pane_id}", "cat");
    const project = JSON.parse(await readFile(mappingIn(directory), "utf8")).project as string;
    const shown = JSON.parse(await cli("show", "index", "--workspace", directory, "--project", project, "--pane", harness, "--socket", socket)) as { pane: string };
    const until = async (pane: string, predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 160; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(shown.pane, text => text.includes("Selected:"), "viewer");
    await delay(700);
    const selection = (await tmux("capture-pane", "-p", "-t", shown.pane)).match(/Selected: (\S+)/)?.[1] ?? "";
    expect(selection).not.toBe("");
    // Name, then note: Enter moves on, Enter again saves.
    await tmux("send-keys", "-t", shown.pane, "n");
    await until(shown.pane, text => text.includes("step 1 of 2"), "name step");
    await tmux("send-keys", "-t", shown.pane, ...Array(30).fill("BSpace"));
    await tmux("send-keys", "-t", shown.pane, "-l", "Money side");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    await until(shown.pane, text => text.includes("step 2 of 2"), "note step");
    await tmux("send-keys", "-t", shown.pane, "-l", "Charges and refunds");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    let overlay: { elements: Record<string, { title?: string; note?: string; by?: string }> } = { elements: {} };
    for (let attempt = 0; attempt < 100 && !Object.keys(overlay.elements).length; attempt++) {
      await delay(100);
      overlay = JSON.parse(await readFile(overlayIn(directory), "utf8").catch(() => '{"elements":{}}'));
    }
    const [entry] = Object.values(overlay.elements);
    expect(entry).toEqual({ title: "Money side", note: "Charges and refunds", by: "human" });
    await until(shown.pane, text => text.includes("Money side"), "renamed box after reload");
    // The agent request carries the key and goes to the harness pane.
    await tmux("send-keys", "-t", shown.pane, "m");
    await until(shown.pane, text => text.includes("Ask the agent to improve the map"), "map prompt");
    await tmux("send-keys", "-t", shown.pane, "-l", "what is this for?");
    await tmux("send-keys", "-t", shown.pane, "Enter");
    const typed = (await until(harness, text => text.replace(/\n/g, "").includes("overlay key:"), "request echoed")).replace(/\n/g, "");
    expect(typed).toContain("what is this for?");
    expect(typed).toContain('"by":"agent"');
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
