// Loads the page's wasm. A separate file, so the page's policy needs no inline script.
import init from "./app.js";
await init();
