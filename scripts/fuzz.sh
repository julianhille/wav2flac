#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD
# Fuzzes the encoder with cargo-fuzz (libFuzzer + AddressSanitizer).
#
#   scripts/fuzz.sh                 # every target, 5 minutes each
#   scripts/fuzz.sh encode 3600     # one target for an hour
#
# Needs a nightly toolchain and cargo-fuzz (cargo install cargo-fuzz).
# The corpus grows in fuzz/corpus/<target>; a crash is saved in
# fuzz/artifacts/<target>/ and replays with
#   cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<file>
# Both directories stay out of git.
set -euo pipefail
cd "$(dirname "$0")/../fuzz"

targets=(encode raw_pcm chunk_encoder resampler)
[[ $# -ge 1 ]] && targets=("$1")
seconds=${2:-300}

for t in "${targets[@]}"; do
  echo "» $t for $seconds s"
  # -timeout: one input taking 10 s is a hang. -rss_limit_mb: the inputs are
  # small, so needing more than 2 GiB is a bug too.
  cargo +nightly fuzz run "$t" -- -max_total_time="$seconds" -dict=wav.dict \
    -timeout=10 -rss_limit_mb=2048 -print_final_stats=1 2>&1 |
    grep -E '^(stat::number_of_executed_units|stat::new_units_added|==[0-9]+==|SUMMARY)|panicked|Test unit written'
done
