<!-- SPDX-License-Identifier: 0BSD -->
# License texts of the Rust standard library

The wasm links parts of the Rust standard library. cargo does not list them,
so `scripts/crates.ts` names them (`STD_PARTS`), and this folder holds their
license texts. `scripts/gen-licenses.ts` copies the texts into
`THIRD_PARTY_LICENSES.txt` and the banner of the JS bundles.

The files are third-party texts and are kept as published. They come from
Rust 1.98.1, the release in `rust-toolchain.toml`:

| File | Source |
|---|---|
| `rust-LICENSE-MIT` | `LICENSE-MIT` of [rust-lang/rust](https://github.com/rust-lang/rust), with the lines wrapped at 78 characters |
| `Unicode-3.0.txt` | `LICENSES/Unicode-3.0.txt` of rust-lang/rust, for the Unicode tables in `core` |
| `dlmalloc-LICENSE-MIT` | `LICENSE-MIT` of [dlmalloc](https://crates.io/crates/dlmalloc) 0.2.13 |
| `compiler-builtins-LICENSE.txt` | `library/compiler-builtins/LICENSE.txt` of rust-lang/rust |
| `libm-LICENSE.txt` | `library/compiler-builtins/libm/LICENSE.txt` of rust-lang/rust |

When the toolchain changes, compare the files with the new release, then
set `STD_TEXTS_RELEASE` in `scripts/crates.ts` to it. Until then the
generators fail, so the notices never name a release their texts are not
from. The versions of the crates that a release uses are in its
`library/Cargo.lock`. To see which parts the wasm links, build it with
`CARGO_PROFILE_RELEASE_STRIP=false` and read the crate names in the name
section of `target/wasm32-unknown-unknown/release/wav2flac.wasm`.
