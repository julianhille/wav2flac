// SPDX-License-Identifier: 0BSD
// Writes the license notices of every Rust crate compiled into the wasm (see
// crates.ts) to the file given as the first argument.
// With a second argument it also writes a `/*! @license */` comment for the
// head of the JS bundles: the crate list plus the full notice of every crate
// licensed only under a BSD or MIT license (BSD clause 2 asks binary
// redistributions to reproduce it; MIT asks for it in all copies). The
// comment gives the permission notice of the MIT license once, after the
// copyright notices of the crates that share it. Parts of
// the Rust standard library are linked in too; crates.ts lists them and
// scripts/std-licenses/ holds their notices. Run by scripts/build.sh after
// the cargo build, so every crate's sources are in the local registry.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STD_PARTS, shippedCrates, stdName, stdNoticeText } from './crates.ts';

const [out, bannerOut] = process.argv.slice(2);
if (out === undefined) throw new Error('usage: gen-licenses.ts <output file> [banner file]');

const NOTICE = /^(licen[cs]e|copying|notice|authors)/i;
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
/** A line of dashes, which the notices of compiler_builtins and libm put between their sections. */
const SECTION = /^-{20,}$/m;
/**
 * Replaces the text of the Apache License in a notice by a pointer to it, to
 * keep the banner short. The notices file has the text in full.
 * @param text A notice whose sections are separated by lines of dashes.
 * @returns The notice for the banner.
 */
function withoutApacheText(text: string): string {
  const rule = SECTION.exec(text)?.[0];
  if (rule === undefined) return text;
  return text.split(SECTION).map((s) => {
    if (!/^\s*Apache License\s*$/.test(s.trimStart().split('\n')[0] ?? '')) return s;
    const llvm = /LLVM Exceptions/.test(s) ? ' and of the LLVM exceptions to it' : '';
    return `\n[The text of the Apache License, Version 2.0${llvm}\nis in THIRD_PARTY_LICENSES.txt.]\n`;
  }).join(rule);
}
/** The permission notice of the MIT license, from its first word to its last. */
const MIT_TEXT = /Permission is hereby granted, free of charge,[\s\S]*?DEALINGS IN THE\s+SOFTWARE\./;
/** Stands in the banner for the permission notice. */
const MIT_POINTER = '[The permission notice of the MIT License is at the end of this comment.]';
/** The permission notice as the first notice in the banner words it. */
let mitText: string | undefined;
/**
 * Replaces the permission notice of the MIT license by a pointer to the one
 * copy of it at the end of the banner. A notice that words it differently
 * (line breaks aside) keeps its own.
 * @param text A notice.
 * @returns The notice for the banner.
 */
function withoutMitText(text: string): string {
  const found = MIT_TEXT.exec(text)?.[0];
  if (found === undefined) return text;
  const words = (t: string): string => t.replace(/\s+/g, ' ');
  mitText ??= found;
  return words(found) === words(mitText) ? text.replace(found, MIT_POINTER) : text;
}
/**
 * The lines of a notice as the banner prints them.
 * @param text A notice.
 * @returns The lines.
 */
function bannerLines(text: string): string[] {
  return withoutMitText(withoutApacheText(text)).split('\n');
}
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
}
if (mitText !== undefined) bsd.push('', 'MIT License, the permission notice:', '', ...mitText.split('\n'));
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
