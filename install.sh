#!/bin/sh
# Installs the pathlight binary from the latest GitHub Release into ~/.local/bin (or $PATHLIGHT_INSTALL_DIR).
#   curl -fsSL https://raw.githubusercontent.com/lennox-davidlevy/pathlight/main/install.sh | sh
# Set PATHLIGHT_VERSION=v0.1.0 to pin a release (PATHLIGHT_BASE_URL points at another download location, for testing).
set -eu
repo="lennox-davidlevy/pathlight"
dir="${PATHLIGHT_INSTALL_DIR:-$HOME/.local/bin}"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in linux|darwin) ;; *) echo "pathlight supports Linux and macOS, not $os." >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;; esac
name="pathlight-$os-$arch"
if [ -n "${PATHLIGHT_BASE_URL:-}" ]; then base="$PATHLIGHT_BASE_URL"
elif [ -n "${PATHLIGHT_VERSION:-}" ]; then base="https://github.com/$repo/releases/download/$PATHLIGHT_VERSION"
else base="https://github.com/$repo/releases/latest/download"; fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "Downloading $name…"
curl -fsSL "$base/$name" -o "$tmp/$name" || { echo "Could not download $base/$name (is there a release for $os-$arch?)." >&2; exit 1; }
if curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  want=$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "Checksum mismatch; not installing." >&2; exit 1; }
else
  echo "No SHA256SUMS published for this release; skipping the checksum." >&2
fi
mkdir -p "$dir"
mv "$tmp/$name" "$dir/pathlight"; chmod +x "$dir/pathlight"
echo "Installed $dir/pathlight"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH:  export PATH=\"$dir:\$PATH\"" ;; esac
command -v tmux >/dev/null 2>&1 || echo "pathlight also needs tmux."
echo "Next, once for every project:"
echo "  Claude Code: claude plugin marketplace add $repo && claude plugin install pathlight@pathlight"
echo "  OpenCode:    pathlight init --global"
echo "Then type /pathlight in a project (pathlight doctor says what is missing)."
