# Fuzzing

cargo-fuzz targets for the encoder and resampler. Run them with
`scripts/fuzz.sh`. The targets, what each checks, and how to replay a crash
are in [docs/development.md](../docs/development.md#fuzzing).

`fuzz/` is its own workspace with a committed `Cargo.lock`, and
`scripts/fuzz.sh` builds with `--locked`. When a dependency in the root
`Cargo.toml` changes (a Renovate PR, say), refresh the fuzz lock too:
`cd fuzz && cargo update -p wav2flac`. `scripts/release.ts prepare` does this
for the version bump.
