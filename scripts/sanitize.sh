#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD
# Runs the Rust tests under every sanitizer Rust supports on x86_64 Linux,
# under Miri, and under valgrind. CI runs address (which includes leak
# detection), memory and thread (the sanitizers job).
#
#   scripts/sanitize.sh                  # all: address leak memory thread miri valgrind
#   scripts/sanitize.sh address thread  # some
#
# Needs a nightly toolchain with rust-src and miri (rustup component add
# --toolchain nightly rust-src miri) and valgrind. Logs go to
# target/sanitize/<name>.log; the exit status is non-zero if any run failed.
# WAV2FLAC_TEST_TIER scales the tests as usual (quick by default).
#
# Miri runs the unit tests only (MIRI_ARGS overrides, e.g. "--test leaks"):
# it is about a thousand times slower and cannot run the flac/ffmpeg tools.
set -euo pipefail
cd "$(dirname "$0")/.."

all=(address leak memory thread miri valgrind)
runs=("$@")
[[ ${#runs[@]} -gt 0 ]] || runs=("${all[@]}")

host=x86_64-unknown-linux-gnu
logs=target/sanitize
mkdir -p "$logs"
# Differential tests against flac/ffmpeg add nothing here and may be missing.
export WAV2FLAC_REQUIRE_TOOLS=0

# cargo test under a sanitizer. An explicit --target keeps RUSTFLAGS off build
# scripts and proc macros. MSan and TSan need an instrumented std (build-std).
san() {
  local name=$1 flags="-Zsanitizer=$1" std=()
  case $name in
    memory) flags+=" -Zsanitizer-memory-track-origins"; std=(-Zbuild-std) ;;
    thread) std=(-Zbuild-std) ;;
  esac
  RUSTFLAGS="$flags" RUSTDOCFLAGS="$flags" CARGO_TARGET_DIR="target/san-$name" \
    cargo +nightly test "${std[@]}" --locked --lib --tests --target "$host"
}

miri() {
  # shellcheck disable=SC2086 # MIRI_ARGS is a list of words
  CARGO_TARGET_DIR=target/san-miri cargo +nightly miri test --locked ${MIRI_ARGS:---lib}
}

valgrind_run() {
  local bins bin
  bins=$(CARGO_TARGET_DIR=target/san-valgrind cargo test --locked --lib --tests --no-run \
    --message-format=json | sed -n 's/.*"executable":"\([^"]*\)".*/\1/p')
  for bin in $bins; do
    echo "» valgrind $bin"
    valgrind --quiet --error-exitcode=1 --leak-check=full --errors-for-leak-kinds=definite \
      "$bin" --test-threads=4
  done
}

failed=()
for name in "${runs[@]}"; do
  echo "» $name (log: $logs/$name.log)"
  case $name in
    address | leak | memory | thread) cmd=(san "$name") ;;
    miri) cmd=(miri) ;;
    valgrind) cmd=(valgrind_run) ;;
    *) echo "sanitize: unknown run '$name' (want: ${all[*]})" >&2; exit 2 ;;
  esac
  start=$SECONDS
  if "${cmd[@]}" >"$logs/$name.log" 2>&1; then
    echo "  ok ($((SECONDS - start)) s)"
  else
    echo "  FAILED ($((SECONDS - start)) s):"
    grep -E 'ERROR: |WARNING: ThreadSanitizer|Undefined Behavior|definitely lost|panicked|FAILED' \
      "$logs/$name.log" | head -20 | sed 's/^/    /'
    failed+=("$name")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "sanitize: failed: ${failed[*]}" >&2
  exit 1
fi
