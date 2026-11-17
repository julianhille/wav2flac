# Fuzzing

cargo-fuzz targets for the encoder and resampler. Run them with
`scripts/fuzz.sh`. The targets, what each checks, and how to replay a crash
are in [docs/development.md](../docs/development.md#fuzzing).

`fuzz/` is its own workspace. Its `Cargo.lock` is not committed:
`scripts/fuzz.sh` copies the root `Cargo.lock` in before each run, so the
fuzzed dependencies are the ones the package ships, and only the fuzz-only
crates (`arbitrary`, `libfuzzer-sys`) are resolved on top.
