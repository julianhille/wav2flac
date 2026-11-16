#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD
# Installs the pinned wasm-bindgen CLI and binaryen (wasm-opt) from their
# GitHub releases, verifies the checksums and puts them on PATH.
# Linux x86_64 only (CI). Locally, install the same versions yourself:
# `cargo install wasm-bindgen-cli --version $WASM_BINDGEN` and binaryen
# $BINARYEN from your package manager; scripts/build.sh checks both.
set -euo pipefail

WASM_BINDGEN=0.2.130
WASM_BINDGEN_SHA256=9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f
BINARYEN=126
BINARYEN_SHA256=e487e0eac1f02a6739816c617270b033e5d3f8ca90439301fd0286460322fd76

dest=${RUNNER_TEMP:-/tmp}/wav2flac-tools
mkdir -p "$dest"
cd "$dest"

fetch() { # url sha256 file
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

wb=wasm-bindgen-$WASM_BINDGEN-x86_64-unknown-linux-musl
fetch "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$WASM_BINDGEN/$wb.tar.gz" "$WASM_BINDGEN_SHA256" wb.tar.gz
tar xzf wb.tar.gz

bn=binaryen-version_$BINARYEN
fetch "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN/$bn-x86_64-linux.tar.gz" "$BINARYEN_SHA256" bn.tar.gz
tar xzf bn.tar.gz

echo "$dest/$wb" >> "${GITHUB_PATH:-/dev/null}"
echo "$dest/$bn/bin" >> "${GITHUB_PATH:-/dev/null}"
"$dest/$wb/wasm-bindgen" --version
"$dest/$bn/bin/wasm-opt" --version
