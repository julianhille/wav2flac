<!-- SPDX-License-Identifier: 0BSD -->
# Bundling and license notices

wav2flac itself is 0BSD. The `.wasm` also contains Rust crates under the
BSD-3-Clause, MIT, Apache-2.0 and Unicode-3.0 licenses, and those licenses
ask that their notices go wherever the code goes. An app that ships the
`.wasm` must ship the notices with it, but doesn't have to show them to its
users.

## The notices are in the wasm

`wav2flac.wasm` carries every notice, in full. Its first section, a custom
section named `license`, holds the text of `THIRD_PARTY_LICENSES.txt`.
Engines ignore custom sections, so it doesn't change what the wasm does. The
text is stored as plain UTF-8, uncompressed, right after the 8-byte header
and the section's name, so it makes up the first lines of the file:

```
\0asm...license# Third-party software compiled into wav2flac.wasm

wav2flac itself is licensed 0BSD (see LICENSE). The WebAssembly module also
contains the following Rust crates. Their license notices follow the table.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| audio-codec-algorithms | 0.8.1 | 0BSD OR Apache-2.0 | https://github.com/karip/audio-codec-algorithms |
```

The text is Markdown: a table of every crate, with its version, license and
source, then a section per crate with each of its license files word for
word, in a code block. Nothing is shortened: a crate's Apache or MIT license
is there in full, even where other crates have the same text.

## Reading the notices

In code, `thirdPartyLicenses()` returns the text. It reads the section from
the wasm that is already loaded, so it fetches nothing. It never loads the
wasm itself, and doesn't wait for a load in progress: until `init()` or
`initSync()` has finished, it rejects with an error. So it can't hang on a
stalled download.

```js
import { init, thirdPartyLicenses } from 'wav2flac';

await init();
const markdown = await thirdPartyLicenses();
```

From a shell, on the file or on the URL it is served from:

```sh
head -c 3000 node_modules/wav2flac/pkg/wav2flac.wasm
strings -n 1 wav2flac.wasm | less
curl -s https://example.com/assets/wav2flac-1a2b3c.wasm | head -c 3000
```

Pipe `curl` into another command, or pass `--output -`: on its own it won't
write binary data to a terminal.

The browser's developer tools don't show it: for a `.wasm` response, the
Network tab shows a disassembly of the code, not the bytes of the file, and
custom sections aren't part of it. Read the section with code instead. Without
wav2flac's API, for example in the console of the page:

```js
const module = await WebAssembly.compileStreaming(fetch('/assets/wav2flac.wasm'));
const [section] = WebAssembly.Module.customSections(module, 'license');
console.log(new TextDecoder().decode(section));
```

In Node:

```js
import { readFileSync } from 'node:fs';

const module = new WebAssembly.Module(readFileSync('node_modules/wav2flac/pkg/wav2flac.wasm'));
const [section] = WebAssembly.Module.customSections(module, 'license');
console.log(new TextDecoder().decode(section));
```

## What bundlers do

Vite 8.3 and webpack 5.111 copy the `.wasm` into their output byte for byte,
under a hashed name, so the notices come along. There is nothing to
configure. The JS files carry no notices of their own.

Keep the `.wasm` as it is. `wasm-opt` keeps custom sections, even with
`--strip-debug`, but moves this one to the end of the file. Tools that strip
every custom section, such as `wasm-strip`, remove the notices; if you use
one, ship `THIRD_PARTY_LICENSES.txt` with the `.wasm` instead.

## Without a bundler

When you serve the package's files as they are, or host the `.wasm` yourself
(see [Loading the wasm](loading.md)), the notices are in it. esbuild doesn't
copy the `.wasm`, so with esbuild you host the package's `.wasm` yourself,
notices included.

## The file

The package also has the notices as a file, `pkg/THIRD_PARTY_LICENSES.txt`,
which resolves as `wav2flac/THIRD_PARTY_LICENSES.txt`. Its text is the same
as that of the section. Use it where you want to show the notices, or to
ship them next to a `.wasm` that lost its custom sections.
