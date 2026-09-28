// SPDX-License-Identifier: 0BSD
// Writes the license notices of every Rust crate compiled into the wasm to the
// file given as the first argument: normal dependencies for wasm32, not dev or
// build dependencies, and not proc macros (they only run at compile time).
// With a second argument it also writes a `/*! @license */` comment for the
// head of the JS bundles: the crate list plus the full notice of every crate
// licensed only under a BSD or MIT license (BSD clause 2 asks binary
// redistributions to reproduce it; MIT asks for it in all copies). The Rust
// standard library (core, alloc, std and its dlmalloc allocator) is linked in
// too and gets its notice from RUST_STD below. Run by scripts/build.sh after
// the cargo build, so every crate's sources are in the local registry.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Package {
  id: string;
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
  repository: string | null;
  manifest_path: string;
  targets: { kind: string[] }[];
}
interface Node {
  id: string;
  deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
}
interface Metadata {
  packages: Package[];
  resolve: { root: string; nodes: Node[] };
}

const [out, bannerOut] = process.argv.slice(2);
if (out === undefined) throw new Error('usage: gen-licenses.ts <output file> [banner file]');

const meta = JSON.parse(execFileSync('cargo', [
  'metadata', '--format-version', '1', '--locked', '--filter-platform', 'wasm32-unknown-unknown',
], { encoding: 'utf8', maxBuffer: 64 << 20 })) as Metadata;

const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const packages = new Map(meta.packages.map((p) => [p.id, p]));
const seen = new Set<string>();
const todo = [meta.resolve.root];
while (todo.length > 0) {
  const id = todo.pop()!;
  for (const d of nodes.get(id)?.deps ?? []) {
    if (!d.dep_kinds.some((k) => k.kind === null) || seen.has(d.pkg)) continue;
    if (packages.get(d.pkg)!.targets.some((t) => t.kind.includes('proc-macro'))) continue;
    seen.add(d.pkg);
    todo.push(d.pkg);
  }
}

/** The Rust standard library as linked into every wasm32 build. */
const RUST_STD_NAME = `Rust standard library ${rustVersion()}: core, alloc, std, dlmalloc`;
/** Its MIT notice (the MIT option of its MIT OR Apache-2.0 license). */
const RUST_STD = `Copyright (c) The Rust Project Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * The rustc version the wasm is built with.
 * @returns E.g. `1.98.1`.
 */
function rustVersion(): string {
  return /^rustc (\S+)/.exec(execFileSync('rustc', ['--version'], { encoding: 'utf8' }))?.[1] ?? 'unknown';
}

const NOTICE = /^(licen[cs]e|copying|notice|authors)/i;
const crates = [...seen].map((id) => packages.get(id)!).sort((a, b) => a.name.localeCompare(b.name));
const rule = '='.repeat(78);
const parts = [
  'Third-party software compiled into wav2flac.wasm',
  '',
  'wav2flac itself is licensed 0BSD (see LICENSE). The WebAssembly module also',
  'contains the following Rust crates; their license notices follow.',
  '',
  ...crates.map((c) => `  ${c.name} ${c.version} (${c.license ?? 'see below'})`),
  `  ${RUST_STD_NAME} (MIT OR Apache-2.0)`,
];
/** License expressions that leave no choice but a BSD or MIT license. */
const NOTICE_ONLY = /^(BSD-[23]-Clause|MIT)$/;
/** BSD clause 2, for crates that declare no license expression. */
const BSD_CLAUSE = /Redistributions in binary form must reproduce/i;
const bsd: string[] = [];
for (const c of crates) {
  const dir = dirname(c.manifest_path);
  const files = readdirSync(dir).filter((f) => NOTICE.test(f)).sort();
  if (c.license_file !== null && !files.includes(c.license_file)) files.push(c.license_file);
  if (files.length === 0) throw new Error(`${c.name} ${c.version}: no license file found in ${dir}`);
  parts.push('', rule, `${c.name} ${c.version}`, `License: ${c.license ?? 'see file'}`);
  if (c.repository !== null) parts.push(`Source: ${c.repository}`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8').trimEnd();
    parts.push('', `--- ${f} ---`, '', text);
    // A crate with only a license file gets the BSD treatment when its text
    // carries the binary-redistribution clause.
    const isBsd = c.license === null ? BSD_CLAUSE.test(text) : NOTICE_ONLY.test(c.license);
    if (isBsd && /licen[cs]e/i.test(f)) bsd.push('', `${c.name} ${c.version} (${c.license ?? f}):`, '', ...text.split('\n'));
  }
}
parts.push('', rule, RUST_STD_NAME, 'License: MIT OR Apache-2.0',
  'Source: https://github.com/rust-lang/rust', '', RUST_STD);
bsd.push('', `${RUST_STD_NAME} (MIT OR Apache-2.0, MIT chosen):`, '', ...RUST_STD.split('\n'));
writeFileSync(out, `${parts.join('\n')}\n`);
console.log(`  ${crates.length} crates → ${out}`);

if (bannerOut !== undefined) {
  const lines = [
    '@license',
    'wav2flac is licensed 0BSD. wav2flac.wasm, which this file loads, also contains',
    'the following Rust crates (full notices: THIRD_PARTY_LICENSES.txt):',
    '',
    ...crates.map((c) => `  ${c.name} ${c.version} (${c.license ?? 'see THIRD_PARTY_LICENSES.txt'})`),
    `  ${RUST_STD_NAME} (MIT OR Apache-2.0)`,
    ...bsd,
  ];
  const body = lines.map((l) => (l.trim() === '' ? ' *' : ` * ${l.trimEnd()}`)).join('\n');
  if (body.includes('*/')) throw new Error('license text contains "*/"');
  writeFileSync(bannerOut, `/*!\n${body}\n */\n`);
  console.log(`  license banner (${bsd.length > 0 ? 'with BSD/MIT notices' : 'no notices'}) → ${bannerOut}`);
}
