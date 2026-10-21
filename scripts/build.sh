#!/bin/sh
# Builds the single-file pathlight binary for this machine's platform into dist/pathlight-OS-ARCH.
# OpenTUI ships its native library as one package per platform, so build each release binary on that platform
# (a macOS runner for macOS); cross-compiling fails to resolve the other platforms' packages.
set -eu
cd "$(dirname "$0")/.."
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; esac
mkdir -p dist
bun build --compile src/cli.ts --outfile "dist/pathlight-$os-$arch"
ls -l "dist/pathlight-$os-$arch"
