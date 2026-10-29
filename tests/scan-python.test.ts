import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { python } from "../src/languages/python";
import { scanWorkspace } from "../src/scan";
import { run } from "./effects";

const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);

// The fixture holds every rule once: a src/ layout beside the project root, a namespace package (pricing), relative levels 1 and 2, a barrel
// __init__.py, TYPE_CHECKING, a dynamic import, the standard library, a missing package, a missing module of a workspace package and an import in a function.
test("a Python workspace: every import is read and resolved by the interpreter's rules against the project's roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-python-"));
  try {
    await cp("tests/fixtures/python", directory, { recursive: true });
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.files.map(file => `${file.path} ${file.language} ${file.lines} ${file.exports!.map(item => `${item.kind}:${item.name}`).join(",")}`)).toEqual([
      "app/main.py python 10 const:rules",
      "src/shop/__init__.py python 6 const:VERSION,reexport:Order,reexport:place",
      "src/shop/audit.py python 2 class:Auditor",
      "src/shop/catalog.py python 9 class:Item,function:list_items",
      "src/shop/orders.py python 22 function:place,class:Order",
      "src/shop/pricing/rules.py python 2 function:discount",
    ]);
    expect(scan.imports.map(item => `${item.from}:${item.line} ${item.kind} ${item.specifier} -> ${item.to}`)).toEqual([
      // `import shop`: the package, found under the src/ root.
      "app/main.py:5 import shop -> src/shop/__init__.py",
      // `from shop import Order, Item, catalog, VERSION, ghost`: Order through the barrel to orders.py, Item through its `*` to catalog.py, catalog is a
      // module; VERSION is the barrel's own and ghost is found nowhere, so both stay on __init__.py.
      "app/main.py:6 import shop -> src/shop/__init__.py",
      "app/main.py:6 import shop -> src/shop/catalog.py",
      "app/main.py:6 import shop -> src/shop/orders.py",
      "app/main.py:10 dynamic shop.pricing.rules -> src/shop/pricing/rules.py",
      // The barrel's own lines are kept as they are.
      "src/shop/__init__.py:2 import .orders -> src/shop/orders.py",
      "src/shop/__init__.py:3 import .catalog -> src/shop/catalog.py",
      "src/shop/orders.py:6 import . -> src/shop/catalog.py",
      // pricing has no __init__.py: a namespace package still resolves.
      "src/shop/orders.py:7 import .pricing.rules -> src/shop/pricing/rules.py",
      "src/shop/orders.py:8 import ..shop.catalog -> src/shop/catalog.py",
      "src/shop/orders.py:11 type shop.audit -> src/shop/audit.py",
      "src/shop/orders.py:16 import shop.audit -> src/shop/audit.py",
    ]);
    expect(scan.external.map(item => `${item.from}:${item.line} ${item.package}`)).toEqual([
      "app/main.py:1 importlib", "app/main.py:2 json", "app/main.py:4 requests",
      "src/shop/orders.py:1 __future__", "src/shop/orders.py:3 os", "src/shop/orders.py:4 typing",
    ]);
    // `shop` is a package of this workspace, so `shop.missing` is missing from it rather than a package from outside; `..` from app/ climbs above the root.
    expect(scan.unresolved.map(item => `${item.from}:${item.line} ${item.specifier} ${item.reason}`)).toEqual(["app/main.py:7 shop.missing not-found", "app/main.py:8 .. not-found"]);
    expect(scan.coverage.unscanned).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("roots come from package-dir, setup.cfg and Poetry as well as pyproject.toml, and the nearest root governs a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-python-roots-"));
  const write = (path: string, text: string) => run("sh", ["-c", `mkdir -p "$(dirname "$1")" && printf '%s' "$2" > "$1"`, "sh", join(directory, path), text]);
  try {
    await write("one/pyproject.toml", '[tool.setuptools]\npackage-dir = { "" = "lib" }\n');
    await write("one/lib/alpha/__init__.py", "");
    await write("two/setup.cfg", "[options]\npackage_dir =\n    =code\n");
    await write("two/code/beta.py", "");
    await write("three/pyproject.toml", '[tool.poetry]\npackages = [{ include = "gamma", from = "sources" }]\n');
    await write("three/sources/gamma/__init__.py", "");
    // Two roots each hold a `common` module: the one nearest the importing file wins.
    await write("one/lib/common.py", "");
    await write("two/code/common.py", "");
    await write("two/code/user.py", "import alpha\nimport common\nimport gamma\n");
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.imports.map(item => `${item.specifier} -> ${item.to}`)).toEqual(["alpha -> one/lib/alpha/__init__.py", "common -> two/code/common.py", "gamma -> three/sources/gamma/__init__.py"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a Python declaration is its signature, decorators left out, so a journey's @ file#function round-trips through flow add and flows", async () => {
  await python.load();
  const source = "@app.get('/x')\nasync def fetch(\n    url: str,\n) -> bytes:\n    return b''\n\nclass Store(Base):\n    pass\n";
  expect(python.declaration(source, "fetch")).toBe("async def fetch( url: str, ) -> bytes");
  expect(python.declaration(source, "Store")).toBe("class Store(Base)");
  expect(python.declaration(source, "missing")).toBeUndefined();

  const directory = await mkdtemp(join(tmpdir(), "pathlight-python-flow-"));
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await writeFile(join(directory, "checkout.py"), "@router.post('/cart')\ndef submit_cart(cart: Cart, user: User) -> Order:\n    return order\n\n_hidden = 1\n");
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    await cli("flow", "add", "place-order", "--workspace", directory, "--title", "Placing an order", "--reads", "checkout.py",
      "--step", "customer -> parcel.storefront: opens checkout", "--step", "parcel.storefront -> parcel.commerce.api: submits the cart @ checkout.py#submit_cart");
    expect(await readFile(join(directory, "place-order.behavior.c4"), "utf8")).toContain("notes 'submit_cart | checkout.py | def submit_cart(cart: Cart, user: User) -> Order'");
    const { checkFlows } = await import("../src/flows");
    const journey = (await Effect.runPromise(checkFlows(directory))).journeys[0]!;
    expect(journey.steps[1]!.call).toEqual({ name: "submit_cart", file: "checkout.py", declaration: "def submit_cart(cart: Cart, user: User) -> Order" });
    expect(journey.findings).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
