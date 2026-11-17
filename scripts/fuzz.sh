#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD
# Fuzzes the encoder with cargo-fuzz (libFuzzer + AddressSanitizer).
#
#   scripts/fuzz.sh                 # every target, 5 minutes each
#   scripts/fuzz.sh encode 3600     # one target for an hour
#
# Needs a nightly toolchain and cargo-fuzz (cargo install cargo-fuzz).
# RUSTUP_TOOLCHAIN picks another nightly (CI pins a dated one).
# The corpus grows in fuzz/corpus/<target>; a crash is saved in
# fuzz/artifacts/<target>/ and replays with
#   cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<file>
# The full libFuzzer output goes to fuzz/logs/<target>.log. Corpus, artifacts
# and logs stay out of git. CI runs the same script (the fuzz job).
# fuzz/ is its own workspace. Its Cargo.lock is not committed but seeded from
# the root one on every run, so the fuzzed dependencies are the ones the
# package ships; cargo only resolves the fuzz-only crates on top.
set -euo pipefail
cd "$(dirname "$0")/../fuzz"
cp ../Cargo.lock Cargo.lock

targets=(encode raw_pcm chunk_encoder resampler)
[[ $# -ge 1 ]] && targets=("$1")
seconds=${2:-300}
nightly=${RUSTUP_TOOLCHAIN:-nightly}

mkdir -p logs
failed=()
for t in "${targets[@]}"; do
  echo "» $t for $seconds s (log: fuzz/logs/$t.log)"
  # -timeout: one input taking 10 s is a hang. -rss_limit_mb: the inputs are
  # small, so needing more than 2 GiB is a bug too.
  if cargo "+$nightly" fuzz run "$t" -- -max_total_time="$seconds" -dict=wav.dict \
    -timeout=10 -rss_limit_mb=2048 -print_final_stats=1 >"logs/$t.log" 2>&1; then
    grep -E '^stat::(number_of_executed_units|new_units_added)' "logs/$t.log" | sed 's/^/  /'
  else
    echo "  FAILED; input saved in fuzz/artifacts/$t/:"
    grep -E '==[0-9]+==|SUMMARY|panicked|Test unit written' "logs/$t.log" | head -20 | sed 's/^/    /'
    failed+=("$t")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "fuzz: failed: ${failed[*]}" >&2
  exit 1
fi
