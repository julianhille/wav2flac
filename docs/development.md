<!-- SPDX-License-Identifier: 0BSD -->
# Development

How to build wav2flac, run its tests, and hunt for leaks and crashes. The
encoder is a Rust crate compiled to wasm; `ts/` wraps it for JavaScript.

## Tools

| Tool                    | Version                                                    | Needed for                        |
| ----------------------- | ---------------------------------------------------------- | --------------------------------- |
| Rust                    | pinned in `rust-toolchain.toml`, with `wasm32-unknown-unknown` | everything                    |
| Node                    | ≥ 22.18 (`devEngines`)                                     | build scripts, JS tests           |
| `wasm-bindgen` CLI      | same as the `wasm-bindgen` crate in `Cargo.toml`           | `npm run build`                   |
| binaryen (`wasm-opt`)   | `BINARYEN` in `scripts/ci-tools.sh`                        | `npm run build`                   |
| `flac`, `ffmpeg`        | any                                                        | differential tests (optional)     |
| Rust nightly, valgrind  | any recent                                                 | sanitizers, Miri, fuzzing (local) |

`scripts/build.sh` refuses to build with a different `wasm-bindgen` or
`wasm-opt` version, because the wasm would differ from the published one. On
Linux x86_64, `RUNNER_TEMP=/some/dir scripts/ci-tools.sh` downloads the pinned
versions and verifies their checksums.

## Build

```sh
npm ci
npm run build   # pkg/: wasm, ESM + CJS bundles, type declarations
```

## Tests

```sh
cargo test               # Rust: the encoder, streaming, options, leaks, …
npm run test:unit        # JS wrapper against the wasm built from source
npm run coverage         # the same, with coverage in coverage/js
npm run test:pkg         # the built pkg/: ESM, CJS, worker, consumer types
npm run test:browser     # packed package in real browsers and bundlers
npm run typecheck && npm run lint && npm run format:check
```

Environment variables:

- `WAV2FLAC_TEST_TIER=quick|full|soak` scales the test matrices, property
  runs and leak windows. `quick` (the default) runs on every push, `full`
  nightly and on release tags, `soak` only by hand.
- `WAV2FLAC_REQUIRE_TOOLS=1` turns a missing `flac` or `ffmpeg` into a
  failure. Without it, the checks that need them are skipped with a warning.
- `FC_SEED` and `FC_PATH` replay a failing fast-check case. fast-check
  prints both when a property fails.
- `WAV2FLAC_BROWSERS=chromium,firefox,webkit` picks the browsers for
  `test:browser`.

## Memory leaks

Safe Rust can still leak: `Box::leak`, `mem::forget`, `Rc` cycles, or a
buffer that keeps growing while something still points to it. Three layers
look for leaks:

- **`tests/leaks.rs`** counts every allocation with a counting global
  allocator. A long-running stream must plateau: its peak in a second window
  of pushes may not exceed the peak in the first. Every encoder, whether
  finished, abandoned or failed, must free everything it allocated.
- **`tests/unit/leaks.test.ts`** pushes 20,000 chunks (quick tier) through
  `encodeStream`, the resampler and the chunk encoders. The wasm memory must
  stay flat, and the open-session counter is checked after every test.
- **LeakSanitizer**, as part of AddressSanitizer, runs the Rust tests on
  nightly in CI (the `sanitizers` job). It finds memory that nothing points
  to at exit, which the counting tests can't see.

## Sanitizers, Miri, valgrind

`scripts/sanitize.sh` runs the Rust tests under every sanitizer Rust supports
on x86_64 Linux, then under Miri and valgrind:

```sh
rustup toolchain install nightly --component rust-src,miri
scripts/sanitize.sh                  # address leak memory thread miri valgrind
scripts/sanitize.sh address thread   # some of them
```

Each run writes a full log to `target/sanitize/<name>.log` and builds into its
own `target/san-<name>`, so the runs don't rebuild each other's artifacts.
MemorySanitizer and ThreadSanitizer build an instrumented std, which takes a
few minutes the first time. Miri runs only the unit tests by default, because
it is about a thousand times slower; `MIRI_ARGS="--test leaks"` picks other
tests.

CI runs AddressSanitizer (with leak detection), MemorySanitizer and
ThreadSanitizer on every push and PR, on the quick tier. Miri and valgrind run
locally only. The crate is `#![forbid(unsafe_code)]` and links no C, so the
sanitizers mainly check the `unsafe` code inside dependencies.

## Fuzzing

`fuzz/` holds [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz) targets:
libFuzzer with AddressSanitizer.

```sh
cargo install cargo-fuzz
scripts/fuzz.sh                 # every target, 5 minutes each
scripts/fuzz.sh encode 3600     # one target for an hour
```

| Target          | Input                                                      | Checks                                                       |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `encode`        | WAV bytes, options, push sizes                             | no panic; output does not depend on how the input is split   |
| `raw_pcm`       | raw PCM of any format, declared length or none, push sizes | no panic; the encoder stays failed after an error            |
| `chunk_encoder` | any sequence of push, cut and finish                       | no panic; every file starts with `fLaC`                      |
| `resampler`     | rates, channels, quality, pushes                           | no panic; output has exactly `ceil(frames × out / in)` frames |

The corpus grows in `fuzz/corpus/<target>`. A crash is saved to
`fuzz/artifacts/<target>/`; replay it with
`cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<file>`. Neither
directory is committed.

CI fuzzes every target for 3 minutes on each push and PR, and for 40 minutes
nightly (the `fuzz` job). libFuzzer picks a new random seed each run, and the
corpus is cached between runs, so each run starts where the last one stopped.
When a run finds a crash, the job fails, prints the log, and uploads the
crashing input as the `fuzz-crash-<target>` artifact.

## Before a commit

- `cargo fmt --all` and `scripts/check-line-width.sh`: no line over 100
  characters, including comments and string literals.
- `npm run format` for everything Prettier covers.
- Every source file starts with `SPDX-License-Identifier: 0BSD`.
- A user-visible change gets an entry under `## [Unreleased]` in
  `CHANGELOG.md`.
- New dependencies must be permissively licensed; `cargo deny check` enforces
  `deny.toml`.

## Docs

This site is MkDocs on Read the Docs:

```sh
pip install -r docs/requirements.txt
npm run docs:api
cp README.md docs/index.md
mkdocs serve
```
