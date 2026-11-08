import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { loadPage } from "../src/web/page";
import { startWebServer, type WebServer } from "../src/web/server";
import { selectView } from "./effects";

// The browser page end to end, in headless Chrome with a software GPU (no window). Rune's DOM mirror changes even when nothing is drawn, so
// what is drawn is checked in the pixels of a screenshot. Skipped, saying why, when the page is not built (scripts/build-web.sh needs Rust)
// or Chrome is not installed; Playwright comes with likec4.
const flags = ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader"];

const page = await loadPage();
const playwright = await import("playwright").catch(() => undefined);
const browser = page && playwright ? await playwright.chromium.launch({ headless: true, channel: "chrome", args: flags }).catch(() => undefined) : undefined;
const why = !page ? "the browser page is not built (sh scripts/build-web.sh)" : !playwright ? "Playwright is not installed" : !browser ? "Chrome is not installed" : "";
if (why) console.warn(`web-page: skipped, ${why}`);

let web: WebServer;
beforeAll(async () => {
  if (why) return;
  web = await Effect.runPromise(startWebServer(await selectView("examples/parcel", "services"), { theme: "pathlight" }));
});
afterAll(async () => {
  await browser?.close();
  await web?.stop();
});

type Page = NonNullable<Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>>>;

/** The place of a box, from Rune's mirror of it: a button whose text is the box's title. */
const boxAt = (p: Page, title: string) => p.evaluate(name => {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === name && b.getBoundingClientRect().x < 1100);
  if (!button) return undefined;
  const r = button.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, title);

/**
 * How much of a screenshot's area is not the table it sits on, decoded by the browser itself. The table is painted (a pool of light, grain,
 * a vignette), so "the table" is the clip's own top-left pixel, and a pixel counts as drawn when it is well away from that.
 */
const drawn = async (p: Page, clip: { x: number; y: number; width: number; height: number }) => {
  const png = (await p.screenshot({ clip })).toString("base64");
  return p.evaluate(async ({ png, w, h }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, w, h);
    const data = context.getImageData(0, 0, w, h).data;
    const [r, g, b] = [data[0]!, data[1]!, data[2]!];
    let differ = 0, sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i]! - r) + Math.abs(data[i + 1]! - g) + Math.abs(data[i + 2]! - b) > 40) differ++;
      sum = (sum * 31 + data[i]! * 7 + data[i + 1]! * 3 + data[i + 2]!) % 1_000_000_007;
    }
    return { share: differ / (w * h), sum };
  }, { png, w: Math.round(clip.width), h: Math.round(clip.height) });
};

test.skipIf(Boolean(why))("the page draws the map, and a click on a box selects it through the server", async () => {
  const p = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  p.on("pageerror", error => errors.push(error.message));
  await p.goto(web.url);
  let box: Awaited<ReturnType<typeof boxAt>>;
  for (let i = 0; i < 80 && !box; i++) { await p.waitForTimeout(250); box = await boxAt(p, "Orders"); }
  expect(box).toBeDefined();
  await p.waitForTimeout(1500);
  // The view and the selection the server chose are in the address.
  expect(p.url()).toContain("view=services");
  expect(p.url()).toContain("select=parcel.commerce.api");
  const before = await drawn(p, box!);
  expect(before.share).toBeGreaterThan(0.5);
  // The rail's empty space below the views is the background: nothing is drawn there.
  expect((await drawn(p, { x: 20, y: 600, width: 180, height: 200 })).share).toBeLessThan(0.02);

  await p.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < 40 && !p.url().includes("select=parcel.commerce.orders"); i++) await p.waitForTimeout(100);
  expect(p.url()).toContain("select=parcel.commerce.orders");
  await p.waitForTimeout(800);
  // Its outline is now the selection's color.
  expect((await drawn(p, box!)).sum).not.toBe(before.sum);
  expect(errors).toEqual([]);
  await p.close();
}, 60_000);
