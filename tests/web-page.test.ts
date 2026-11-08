import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { loadPage } from "../src/web/page";
import { startWebServer, type WebServer } from "../src/web/server";
import { selectView } from "./effects";

// The browser page end to end, in headless Chrome (Playwright comes with likec4; no GPU and no flags are needed). What is drawn is read from the
// DOM: the selected id, the inspector's rows, the connectors' paths, the camera's transform, where the inspector sits. Skipped, saying why, when
// the page is not built (bun scripts/build-page.ts) or Chrome is not installed. The Rune page's pixel test runs only when its pack is built.

const page = await loadPage("page");
const rune = await loadPage("rune");
const playwright = await import("playwright").catch(() => undefined);
const browser = (page || rune) && playwright ? await playwright.chromium.launch({ headless: true, channel: "chrome" }).catch(() => undefined) : undefined;
const why = !page ? "the browser page is not built (bun scripts/build-page.ts)" : !playwright ? "Playwright is not installed" : !browser ? "Chrome is not installed" : "";
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

const opened = async (width: number, height: number, path = "") => {
  const p = await browser!.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  p.on("pageerror", error => errors.push(error.message));
  p.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await p.goto(`${web.url}${path}`);
  await p.waitForSelector(".footer", { timeout: 15_000 });
  return { p, errors };
};
const until = async (p: Page, check: () => Promise<boolean>) => { for (let i = 0; i < 60 && !(await check()); i++) await p.waitForTimeout(50); };
const transform = (p: Page) => p.$eval(".diagram > g", g => g.getAttribute("transform") ?? "");
const scaleOf = (matrix: string) => Number(/matrix\(([-\d.e]+)/.exec(matrix)?.[1] ?? NaN);
const inspectorText = (p: Page) => p.$$eval(".inspector .line", lines => lines.map(line => line.textContent ?? ""));
const selectedCard = (p: Page) => p.$eval(".diagram .card.selected", card => card.getAttribute("data-id"));

test.skipIf(Boolean(why))("the page draws the terminal's diagram and inspector, and a click selects through the server", async () => {
  const { p, errors } = await opened(1440, 900);
  try {
    expect(p.url()).toContain("view=services");
    expect(p.url()).toContain("select=parcel.commerce.api");
    expect(await p.$eval(".header", header => header.textContent)).toContain("◆ pathlight / Parcel / Service architecture");
    expect(await p.$eval(".header", header => header.textContent)).toContain("16 boxes");
    // Every card and every connector of the view, one-pixel lines, the selected card in the accent.
    expect(await p.$$eval(".diagram .card", cards => cards.length)).toBe(16);
    const scene = await (await fetch(web.url.replace("/?t=", "/api/scene?t="))).json() as { views: { id: string; routes: unknown[] }[] };
    expect(await p.$$eval(".diagram .route polyline", lines => lines.length)).toBe(scene.views.find(view => view.id === "services")!.routes.length);
    expect(await p.$$eval(".diagram .route.lit", lines => lines.length)).toBe(4);
    for (const points of await p.$$eval(".diagram .route polyline", lines => lines.map(line => line.getAttribute("points")!))) {
      const pairs = points.split(" ").map(pair => pair.split(",").map(Number));
      for (let i = 1; i < pairs.length; i++) expect(pairs[i]![0] === pairs[i - 1]![0] || pairs[i]![1] === pairs[i - 1]![1]).toBe(true);
    }
    const accent = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    expect(await p.$eval('.diagram .card[data-id="parcel.commerce.api"] .edge', edge => edge.getAttribute("stroke"))).toBe(accent);
    expect((await inspectorText(p)).slice(0, 4).map(line => line.trimEnd())).toEqual(["Checkout API", "TypeScript / HTTP", "Validates carts, reserves stock, and authorizes", "payment."]);

    await p.click('.diagram .card[data-id="parcel.commerce.orders"] .edge');
    await until(p, async () => p.url().includes("select=parcel.commerce.orders"));
    expect(p.url()).toContain("select=parcel.commerce.orders");
    expect((await inspectorText(p))[0]!.trim()).toBe("Orders");
    expect(await p.$eval('.diagram .card[data-id="parcel.commerce.orders"] .edge', edge => edge.getAttribute("stroke"))).toBe(accent);
    // A Connects row selects the box it names.
    await p.click(".inspector .row >> text=Checkout API");
    await until(p, async () => p.url().includes("select=parcel.commerce.api"));
    expect(await selectedCard(p)).toBe("parcel.commerce.api");
    expect(await p.$eval(".footer", footer => footer.textContent)).toContain("Selected: parcel.commerce.api");
    expect(errors).toEqual([]);
  } finally { await p.close(); }
}, 60_000);

test.skipIf(Boolean(why))("the camera fits, zooms about the pointer, pans, fits again with f, and Back puts it back", async () => {
  const { p, errors } = await opened(1440, 900);
  try {
    await p.waitForTimeout(200);
    const fitted = await transform(p);
    const box = (await p.$(".diagram"))!;
    const area = (await box.boundingBox())!;
    await p.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await p.keyboard.down("Control"); await p.mouse.wheel(0, -200); await p.keyboard.up("Control");
    await p.waitForTimeout(200);
    const zoomed = await transform(p);
    expect(scaleOf(zoomed)).toBeGreaterThan(scaleOf(fitted) * 1.5);
    // The footer says the new zoom once the camera stops.
    await until(p, async () => !(await p.$eval(".footer", footer => footer.textContent ?? "")).includes("zoom 59%"));
    expect(await p.$eval(".footer", footer => footer.textContent)).toMatch(/zoom \d+%/);
    await p.mouse.move(area.x + 200, area.y + 200);
    await p.mouse.down(); await p.mouse.move(area.x + 320, area.y + 260, { steps: 4 }); await p.mouse.up();
    const panned = await transform(p);
    expect(panned).not.toBe(zoomed);
    expect(scaleOf(panned)).toBeCloseTo(scaleOf(zoomed), 6);
    // A drag is not a click: the selection stays.
    expect(await selectedCard(p)).toBe("parcel.commerce.api");

    // Leaving for another view and coming back with b puts the camera and the selection back where they were.
    await p.click(".rail .row >> text=Checkout detail");
    await until(p, async () => p.url().includes("view=checkout"));
    expect(await p.$$eval(".diagram .card", cards => cards.length)).toBe(8);
    await p.keyboard.press("b");
    await until(p, async () => p.url().includes("view=services"));
    await p.waitForTimeout(50);
    expect(await transform(p)).toBe(panned);
    expect(await selectedCard(p)).toBe("parcel.commerce.api");

    await p.keyboard.press("f");
    await p.waitForTimeout(250);
    expect(await transform(p)).toBe(fitted);
    expect(errors).toEqual([]);
  } finally { await p.close(); }
}, 60_000);

test.skipIf(Boolean(why))("the inspector sits where the terminal puts it at each size, and under 80 columns the node list replaces the diagram", async () => {
  const placements: Record<string, unknown> = {};
  for (const [width, height] of [[1440, 900], [1000, 900], [1000, 600], [600, 600]] as const) {
    const { p, errors } = await opened(width, height);
    try {
      const diagram = await p.$(".diagram"), inspector = await p.$(".inspector");
      const d = await diagram?.boundingBox(), i = await inspector?.boundingBox();
      placements[`${width}x${height}`] = !d ? (await p.$(".node-list") ? "list" : "none") : !i ? "none" : i.x >= d.x + d.width ? "docked" : i.y >= d.y + d.height ? "below" : "overlay";
      if (width === 1000 && height === 600) {
        await p.keyboard.press("i");
        await p.waitForSelector(".inspector.overlay");
        placements["1000x600 i"] = "overlay";
        await p.keyboard.press("Escape");
        await until(p, async () => !(await p.$(".inspector")));
        placements["1000x600 i esc"] = (await p.$(".inspector")) ? "overlay" : "none";
      }
      if (width === 600) {
        await p.keyboard.press("ArrowDown");
        // The next row of the list, as the terminal's down arrow moves in it.
        await until(p, async () => p.url().includes("select=parcel.commerce.relay"));
        expect(p.url()).toContain("select=parcel.commerce.relay");
      }
      expect(errors).toEqual([]);
    } finally { await p.close(); }
  }
  expect(placements).toEqual({ "1440x900": "docked", "1000x900": "below", "1000x600": "none", "1000x600 i": "overlay", "1000x600 i esc": "none", "600x600": "list" });
}, 90_000);

test.skipIf(Boolean(why))("the keys are the terminal's: arrows select a neighbor, enter goes in, backspace goes up, ? shows the help", async () => {
  const { p, errors } = await opened(1440, 900);
  try {
    await p.keyboard.press("ArrowRight");
    await until(p, async () => p.url().includes("select=parcel.commerce.inventory"));
    expect(await selectedCard(p)).toBe("parcel.commerce.inventory");
    await p.keyboard.press("Backspace");
    await until(p, async () => p.url().includes("select=parcel.commerce&") || p.url().endsWith("select=parcel.commerce"));
    expect(await selectedCard(p)).toBe("parcel.commerce");
    await p.keyboard.press("Enter");
    await until(p, async () => (await selectedCard(p)) !== "parcel.commerce");
    expect(await p.$eval(".header", header => header.textContent)).toContain("back 1");
    await p.keyboard.press("?");
    await p.waitForSelector(".help");
    const help = await p.$eval(".help", element => element.textContent ?? "");
    expect(help).toContain("into a box");
    expect(help).not.toContain("follow the work");
    await p.keyboard.press("Escape");
    await until(p, async () => !(await p.$(".help")));
    expect(await p.$(".help")).toBeNull();
    expect(errors).toEqual([]);
  } finally { await p.close(); }
}, 60_000);

/**
 * Speed, measured (plan 4d, "Tests"): from navigation to the first paint, and to the diagram drawn; then the longest frame while panning for a
 * second with the wheel. Printed for the handoff; the assertions are loose bounds a slow machine still meets, the numbers are the fact.
 */
test.skipIf(Boolean(why))("the page paints fast and pans without long frames", async () => {
  const { p, errors } = await opened(1440, 900);
  try {
    await until(p, async () => p.evaluate(() => performance.getEntriesByName("pathlight:drawn").length > 0));
    const timing = await p.evaluate(() => ({
      paint: performance.getEntriesByType("paint").find(entry => entry.name === "first-contentful-paint")?.startTime,
      drawn: performance.getEntriesByName("pathlight:drawn")[0]!.startTime,
      scene: performance.getEntriesByType("resource").find(entry => entry.name.includes("/api/scene"))?.duration,
    }));
    const frames = await p.evaluate(async () => {
      const svg = document.querySelector(".diagram")!, box = svg.getBoundingClientRect();
      const times: number[] = [];
      let last = performance.now();
      const end = last + 1000;
      return new Promise<number[]>(resolve => {
        const tick = (now: number) => {
          times.push(now - last); last = now;
          svg.dispatchEvent(new WheelEvent("wheel", { deltaX: 7, deltaY: 5, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true, cancelable: true }));
          if (now < end) requestAnimationFrame(tick); else resolve(times.slice(2));
        };
        requestAnimationFrame(tick);
      });
    });
    const longest = Math.max(...frames), median = [...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)]!;
    console.log(`web-page speed: first contentful paint ${timing.paint === undefined ? "not reported" : `${timing.paint.toFixed(0)} ms`}, the map drawn at ${timing.drawn.toFixed(0)} ms (the scene took ${timing.scene?.toFixed(0)} ms), panning ${frames.length} frames, median ${median.toFixed(1)} ms, longest ${longest.toFixed(1)} ms`);
    expect(timing.drawn).toBeLessThan(2000);
    expect(longest).toBeLessThan(250);
    expect(errors).toEqual([]);
  } finally { await p.close(); }
}, 60_000);

// The Rune page (experimental, `pathlight web --rune`), in pixels with a software GPU: runs only when its pack is built (PATHLIGHT_RUNE=1).
const runeWhy = !rune ? "the Rune page is not built (sh scripts/build-web.sh)" : !playwright ? "Playwright is not installed" : "";
test.skipIf(Boolean(runeWhy))("the Rune page still draws the map and selects through the server", async () => {
  const flags = ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader"];
  const gpu = await playwright!.chromium.launch({ headless: true, channel: "chrome", args: flags }).catch(() => undefined);
  if (!gpu) { console.warn("web-page: Rune test skipped, Chrome is not installed"); return; }
  const served = await Effect.runPromise(startWebServer(await selectView("examples/parcel", "services"), { theme: "pathlight", kind: "rune" }));
  try {
    const p = await gpu.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    p.on("pageerror", error => errors.push(error.message));
    await p.goto(served.url);
    const boxAt = () => p.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Orders" && b.getBoundingClientRect().x < 1100);
      if (!button) return undefined;
      const r = button.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    let box: Awaited<ReturnType<typeof boxAt>>;
    for (let i = 0; i < 80 && !box; i++) { await p.waitForTimeout(250); box = await boxAt(); }
    expect(box).toBeDefined();
    await p.waitForTimeout(1500);
    expect(p.url()).toContain("select=parcel.commerce.api");
    await p.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    for (let i = 0; i < 40 && !p.url().includes("select=parcel.commerce.orders"); i++) await p.waitForTimeout(100);
    expect(p.url()).toContain("select=parcel.commerce.orders");
    expect(errors).toEqual([]);
    await p.close();
  } finally { await gpu.close(); await served.stop(); }
}, 60_000);
