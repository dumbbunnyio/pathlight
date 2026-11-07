#!/bin/sh
# Builds the single-file pathlight binary for this machine's platform into dist/pathlight-OS-ARCH.
# OpenTUI ships its native library as one package per platform, so build each release binary on that platform
# (a macOS runner for macOS); cross-compiling fails to resolve the other platforms' packages.
set -eu
cd "$(dirname "$0")/.."
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; esac
mkdir -p dist
# The browser page (web/, Rust on Rune): built here when Rust and wasm-bindgen are, embedded when it is built. A binary without it runs
# everything else, and pathlight web says how to build the page.
if command -v cargo >/dev/null 2>&1 && command -v "${WASM_BINDGEN:-wasm-bindgen}" >/dev/null 2>&1; then sh scripts/build-web.sh; fi
if [ -f web/dist/pathlight-page.gz ]; then
  bun build --compile src/cli.ts web/dist/pathlight-page.gz --loader .gz:file --outfile "dist/pathlight-$os-$arch"
else
  echo "build: no browser page in web/dist (scripts/build-web.sh needs Rust and wasm-bindgen); building without it" >&2
  bun build --compile src/cli.ts --outfile "dist/pathlight-$os-$arch"
fi
ls -l "dist/pathlight-$os-$arch"
