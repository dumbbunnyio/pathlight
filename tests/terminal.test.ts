import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./effects";

test("a delayed pixel-resolution reply refits a Unicode image without keyboard input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-terminal-"));
  try {
    const image = join(directory, "pixel.png");
    await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"));
    expect(await run("python3", [resolve("tests/terminal-probe.py"), process.execPath,
      resolve("src/cli.ts"), "image", image, "--protocol", "kitty-unicode"])).toBe(
      "Delayed pixel resolution changed fit without a keypress; quit deleted the image.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
