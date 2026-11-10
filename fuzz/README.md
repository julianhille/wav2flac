# Fuzzing

Coverage-guided fuzz targets for [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz)
(libFuzzer with AddressSanitizer). They need a nightly toolchain and
`cargo install cargo-fuzz`. Run them with `scripts/fuzz.sh`.

| Target          | Input                                                       | Checks                                                    |
| --------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `encode`        | WAV bytes, options, push sizes                              | no panic; output does not depend on how input is split    |
| `raw_pcm`       | raw PCM of any format, declared length or none, push sizes  | no panic; the encoder stays failed after an error         |
| `chunk_encoder` | any sequence of push, cut and finish                        | no panic; every file starts with `fLaC`                   |
| `resampler`     | rates, channels, quality, pushes                            | no panic; output has exactly `ceil(frames × out / in)` frames |

`wav.dict` lists RIFF/WAV tokens, which helps the fuzzer find valid headers.
`corpus/` and `artifacts/` are not committed.

`scripts/sanitize.sh` runs the Rust tests under ASan, LSan, MSan, TSan, Miri
and valgrind. CI runs only LeakSanitizer.
