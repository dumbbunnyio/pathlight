#!/bin/sh
# Builds the browser page (web/, Rust on Rune, compiled to wasm) into web/dist/pathlight-page.gz, which pathlight web serves and
# scripts/build.sh embeds. Needs Rust (web/rust-toolchain.toml), its wasm32-unknown-unknown target, and wasm-bindgen at the version web/Cargo.lock
# pins (WASM_BINDGEN names it if it is not on the PATH). CARGO_TARGET_DIR is honored, so a shared build folder can be reused.
set -eu
cd "$(dirname "$0")/.."
bindgen=${WASM_BINDGEN:-wasm-bindgen}
want=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' web/Cargo.lock)
if ! command -v cargo >/dev/null 2>&1; then echo "build-web: cargo not found; install Rust (https://rustup.rs)" >&2; exit 1; fi
if ! command -v "$bindgen" >/dev/null 2>&1; then echo "build-web: wasm-bindgen not found; cargo install wasm-bindgen-cli --version $want" >&2; exit 1; fi
have=$("$bindgen" --version | awk '{ print $2 }')
if [ "$have" != "$want" ]; then echo "build-web: wasm-bindgen $have does not match $want in web/Cargo.lock; cargo install wasm-bindgen-cli --version $want" >&2; exit 1; fi
target=${CARGO_TARGET_DIR:-web/target}
# From inside web/, so rustup takes web/rust-toolchain.toml (it reads the folder, not the manifest).
(cd web && cargo build --release --lib --target wasm32-unknown-unknown)
rm -rf web/dist/page
mkdir -p web/dist/page
"$bindgen" --target web --no-typescript --out-dir web/dist/page --out-name app "$target/wasm32-unknown-unknown/release/pathlight_web.wasm"
cp web/index.html web/boot.js web/dist/page/
bun scripts/pack-web.ts web/dist/page web/dist/pathlight-page.gz
