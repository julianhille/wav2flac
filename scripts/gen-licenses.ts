// SPDX-License-Identifier: 0BSD
// Writes the license notices of every Rust crate compiled into the wasm (see
// crates.ts) to the file given as the first argument.
// With a second argument it also writes a `/*! @license */` comment for the
// head of the JS bundles: the crate list, the license notice of every crate
// licensed only under a BSD or MIT license (BSD clause 2 asks binary
// redistributions to reproduce it; MIT asks for it in all copies), and the
// notices of the parts of the Rust standard library marked for it in
// crates.ts, whose texts are in scripts/std-licenses/. The comment gives the
// permission notice of the MIT license once, at its end, and points to
// THIRD_PARTY_LICENSES.txt for the Apache License and the notices it leaves
// out. Run by scripts/build.sh after the cargo build, so every crate's
// sources are in the local registry.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STD_PARTS, noticeFiles, shippedCrates, stdName, stdNoticeText } from './crates.ts';
import { MIT_NOTICE, MIT_POINTER, bannerLines } from './notices.ts';

const [out, bannerOut] = process.argv.slice(2);
if (out === undefined) throw new Error('usage: gen-licenses.ts <output file> [banner file]');

const crates = shippedCrates();
const rule = '='.repeat(78);
const parts = [
  'Third-party software compiled into wav2flac.wasm',
  '',
  'wav2flac itself is licensed 0BSD (see LICENSE). The WebAssembly module also',
  'contains the following Rust crates; their license notices follow.',
  '',
  ...crates.map((c) => `  ${c.name} ${c.version} (${c.license ?? 'see below'})`),
  ...STD_PARTS.map((p) => `  ${stdName(p)} (${p.license})`),
];
/** License expressions that leave no choice but a BSD or MIT license. */
const NOTICE_ONLY = /^(BSD-[23]-Clause|MIT)$/;
/** BSD clause 2, for crates that declare no license expression. */
const BSD_CLAUSE = /Redistributions in binary form must reproduce/i;
const bsd: string[] = [];
for (const c of crates) {
  const dir = dirname(c.manifest_path);
  const files = noticeFiles(c);
  parts.push('', rule, `${c.name} ${c.version}`, `License: ${c.license ?? 'see file'}`);
  if (c.repository !== null) parts.push(`Source: ${c.repository}`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8').trimEnd();
    parts.push('', `--- ${f} ---`, '', text);
    // A crate with only a license file gets the BSD treatment when its text
    // carries the binary-redistribution clause.
    const isBsd = c.license === null ? BSD_CLAUSE.test(text) : NOTICE_ONLY.test(c.license);
    if (isBsd && /licen[cs]e/i.test(f)) bsd.push('', `${c.name} ${c.version} (${c.license ?? f}):`, '', ...bannerLines(text));
  }
}
for (const p of STD_PARTS) {
  parts.push('', rule, stdName(p), `License: ${p.license}`, `Source: ${p.repository}`);
  const chosen = p.chosen === undefined ? '' : `, ${p.chosen} chosen`;
  for (const n of p.notices) {
    const text = stdNoticeText(n);
    parts.push('', `--- ${n.title} ---`, '', text);
    if (!n.banner) continue;
    const title = p.notices.filter((o) => o.banner).length > 1 ? `: ${n.title}` : '';
    bsd.push('', `${stdName(p)}${title} (${p.license}${chosen}):`, '', ...bannerLines(text));
  }
  for (const n of p.notices.filter((o) => !o.banner)) {
    bsd.push('', `[The notice ${n.title} is in THIRD_PARTY_LICENSES.txt.]`);
  }
}
if (bsd.some((l) => l.includes(MIT_POINTER))) bsd.push('', 'MIT License, the permission notice:', '', ...MIT_NOTICE.split('\n'));
writeFileSync(out, `${parts.join('\n')}\n`);
console.log(`  ${crates.length} crates, ${STD_PARTS.length} parts of the standard library → ${out}`);

if (bannerOut !== undefined) {
  const lines = [
    '@license',
    'wav2flac is licensed 0BSD. wav2flac.wasm, which this file loads, also contains',
    'the following Rust crates (full notices: THIRD_PARTY_LICENSES.txt):',
    '',
    ...crates.map((c) => `  ${c.name} ${c.version} (${c.license ?? 'see THIRD_PARTY_LICENSES.txt'})`),
    ...STD_PARTS.map((p) => `  ${stdName(p)} (${p.license})`),
    ...bsd,
  ];
  const body = lines.map((l) => (l.trim() === '' ? ' *' : ` * ${l.trimEnd()}`)).join('\n');
  if (body.includes('*/')) throw new Error('license text contains "*/"');
  writeFileSync(bannerOut, `/*!\n${body}\n */\n`);
  console.log(`  license banner (${bsd.length > 0 ? 'with BSD/MIT notices' : 'no notices'}) → ${bannerOut}`);
}
