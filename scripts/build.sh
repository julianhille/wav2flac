#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD
# Builds the npm package into pkg/: wasm (cargo → wasm-bindgen → wasm-opt),
# ESM + CJS bundles (esbuild) and type declarations (tsc).
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null || { echo "build: '$1' not found ($2)" >&2; exit 1; }; }
need cargo "install Rust with the wasm32-unknown-unknown target"
want=$(sed -n 's/^wasm-bindgen = "=\([^"]*\)".*/\1/p' Cargo.toml)
need wasm-bindgen "cargo install wasm-bindgen-cli --version $want"
need wasm-opt "install binaryen"

have=$(wasm-bindgen --version | awk '{print $2}')
[[ "$want" == "$have" ]] || { echo "build: wasm-bindgen CLI $have != crate $want" >&2; exit 1; }
# Same binaryen as CI (scripts/ci-tools.sh), or the wasm differs between builds.
want_opt=$(sed -n 's/^BINARYEN=\([0-9]*\).*/\1/p' scripts/ci-tools.sh)
have_opt=$(wasm-opt --version | sed -n 's/.*version \([0-9]*\).*/\1/p')
[[ "$want_opt" == "$have_opt" ]] || { echo "build: wasm-opt $have_opt != binaryen $want_opt" >&2; exit 1; }

export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}
# Keep local paths out of the wasm (panic strings, debug info) for reproducible builds.
# CARGO_ENCODED_RUSTFLAGS (0x1f-separated) keeps paths with spaces intact.
sep=$'\x1f'
flags=${CARGO_ENCODED_RUSTFLAGS:-}
if [[ -z "$flags" && -n "${RUSTFLAGS:-}" ]]; then
  read -ra words <<<"$RUSTFLAGS"
  flags=$(IFS=$sep; echo "${words[*]}")
fi
for remap in "$PWD=." "${CARGO_HOME:-$HOME/.cargo}=~/.cargo" "$(rustc --print sysroot)=/rustc"; do
  flags+="${flags:+$sep}--remap-path-prefix=$remap"
done
export CARGO_ENCODED_RUSTFLAGS=$flags
unset RUSTFLAGS

echo "» cargo (wasm32, release)"
cargo build --quiet --locked --release --lib --target wasm32-unknown-unknown

echo "» wasm-bindgen"
rm -rf build/bindgen
wasm-bindgen "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/wav2flac.wasm" \
  --target web --out-dir build/bindgen --out-name wav2flac --omit-default-module-path

echo "» wasm-opt"
rm -rf pkg && mkdir -p pkg
wasm-opt -O3 --strip-debug --strip-producers \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
  build/bindgen/wav2flac_bg.wasm -o pkg/wav2flac.wasm

echo "» third-party licenses"
node scripts/gen-licenses.ts pkg/THIRD_PARTY_LICENSES.txt build/license-banner.js

echo "» esbuild + tsc"
node scripts/build-js.ts

printf '  %-22s %8s %8s\n' file bytes gzip
for f in pkg/wav2flac.wasm pkg/esm/index.js pkg/esm/worker.js pkg/cjs/index.cjs; do
  printf '  %-22s %8d %8d\n' "${f#pkg/}" "$(wc -c <"$f")" "$(gzip -9c "$f" | wc -c)"
done
