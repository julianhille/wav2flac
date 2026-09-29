<!-- SPDX-License-Identifier: 0BSD -->
# Load from a CDN without a bundler

Next to the normal bundles, the package ships minified builds. Use them when
the browser loads the package directly, for example from a CDN, because no
bundler minifies the code for you:

| | normal | minified |
|---|---|---|
| ESM | `pkg/esm/index.js`, `pkg/esm/worker.js` | `pkg/esm/index.min.js`, `pkg/esm/worker.min.js` |
| CommonJS | `pkg/cjs/index.cjs`, `pkg/cjs/worker.cjs` | `pkg/cjs/index.min.cjs`, `pkg/cjs/worker.min.cjs` |

The minified files behave the same and have their own source maps. A
minified index starts the minified worker. `import 'wav2flac'` and
`require('wav2flac')` still resolve to the normal bundles; bundlers minify
those themselves. To load the minified ones by package name, for example
from an import map that points into `node_modules`, import or require
`wav2flac/min`.

Use one or the other in an app, not both. `wav2flac` and `wav2flac/min` are
two copies of the package: each loads its own wasm and needs its own
`init()`, and an error from one is not `instanceof` the other's
`Wav2FlacError`.

## Import from the CDN

Point an import map at `index.min.js`. `@1` follows the latest 1.x release;
in production, pin the exact version you tested, such as `@1.0.0`. `@1` skips
pre-releases: until 1.0.0 is out, name the release candidate you use.

```html
<script type="importmap">
  { "imports": { "wav2flac": "https://cdn.jsdelivr.net/npm/wav2flac@1/pkg/esm/index.min.js" } }
</script>
<script type="module">
  import { encode } from 'wav2flac';

  const wav = new Uint8Array(await (await fetch('/audio/take-1.wav')).arrayBuffer());
  const flac = await encode(wav);
</script>
```

Or import the URL directly:

```js
import { encode } from 'https://cdn.jsdelivr.net/npm/wav2flac@1/pkg/esm/index.min.js';
```

The `.wasm` is fetched from the same CDN folder (`pkg/wav2flac.wasm`), with
`THIRD_PARTY_LICENSES.txt` next to it. To load the wasm from somewhere else or
give up on a stalled download, see [Loading the wasm](../loading.md).

Always use the full path to the file, as above. The package finds its wasm
and worker relative to its own URL, and the shortcuts break that:

- The bare package URL (`https://cdn.jsdelivr.net/npm/wav2flac@1`) serves the
  CommonJS bundle, which a browser cannot import.
- jsDelivr's `/+esm` and esm.sh rebundle the package and serve it from
  another path. The wasm and the worker then resolve to URLs that don't
  exist.

## Workers from a CDN

Browsers only start a worker from a script on the page's own origin. With the
package on a CDN, `createWorkerEncoder()` fails: Chromium throws a
`SecurityError`, Firefox rejects the first job with "the worker script could
not be loaded".

Start the worker from a same-origin `blob:` URL that imports the CDN worker:

```js
import { createWorkerEncoder } from 'wav2flac';

const workerUrl = URL.createObjectURL(new Blob(
  ['import "https://cdn.jsdelivr.net/npm/wav2flac@1/pkg/esm/worker.min.js";'],
  { type: 'text/javascript' },
));
const encoder = createWorkerEncoder({ url: workerUrl });
```

The worker gets the wasm from the page, so it downloads nothing but its own
script. A Content Security Policy must allow `blob:` in `worker-src`, or in
the directive it falls back to when it is not set (`child-src`, then
`script-src`, then `default-src`). Otherwise, copy `worker.min.js` to your
own origin and pass its URL as `url`.

## Licenses

The license notices of the Rust crates are in the `.wasm`, which the
minified and the normal bundles share. Loading from a CDN changes nothing
about them: the page fetches the wasm with the notices in it, and
`THIRD_PARTY_LICENSES.txt` sits next to it. See
[Bundling and license notices](../bundling.md).
