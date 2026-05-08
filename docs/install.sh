#!/bin/sh
set -eu

OWNER="mpppk"
REPO="roadmap-tool"
BIN="roadmap-tool"
INSTALL_DIR="/usr/local/bin"

usage() {
  echo "Usage: install.sh [-b install_dir]" >&2
  exit 1
}

while getopts "b:h" opt; do
  case "$opt" in
    b) INSTALL_DIR="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="Darwin" ;;
  Linux)  OS="Linux"  ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

ASSET="${BIN}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/${ASSET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${BIN} for ${OS}/${ARCH}..."
curl -fsSL "$URL" -o "$TMP_DIR/$ASSET"
tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$TMP_DIR/$BIN" "$INSTALL_DIR/$BIN"

echo "${BIN} installed to ${INSTALL_DIR}/${BIN}"
echo "Run: ${BIN} --help"
