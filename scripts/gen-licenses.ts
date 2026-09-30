// SPDX-License-Identifier: 0BSD
// Writes the license notices of every Rust crate compiled into the wasm (see
// crates.ts) to the file given as the argument, as Markdown: a table of the
// crates, then each notice file verbatim in a code block. embed-notices.ts
// then puts the file into the wasm. Run by scripts/build.sh after the cargo build, so every
// crate's sources are in the local registry.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  STD_PARTS,
  noticeFiles,
  rustVersion,
  shippedCrates,
  stdName,
  stdNoticeText,
} from './crates.ts';

const [out] = process.argv.slice(2);
if (out === undefined) throw new Error('usage: gen-licenses.ts <output file>');

// The notices name the release of rust-toolchain.toml. A rustc that ignores
// the file (one not managed by rustup) or an override may have built the wasm.
const root = join(import.meta.dirname, '..');
const rustc = /^rustc (\S+)/.exec(
  execFileSync('rustc', ['--version'], { cwd: root, encoding: 'utf8' }),
)?.[1];
if (rustc !== rustVersion()) {
  throw new Error(
    `rustc ${rustc} built the wasm, but rust-toolchain.toml pins Rust ${rustVersion()}`,
  );
}

const crates = shippedCrates();
const rustRelease = rustVersion();

/**
 * A Markdown table cell.
 * @param text Cell text.
 * @returns The text with `|` escaped.
 */
const cell = (text: string): string => text.replaceAll('|', '\\|');

/**
 * A Markdown code block that shows the text verbatim.
 * @param text The text.
 * @returns The fenced block, with a fence longer than any backtick run in the text.
 */
function codeBlock(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const parts = [
  '# Third-party software compiled into wav2flac.wasm',
  '',
  'wav2flac itself is licensed 0BSD (see LICENSE). The WebAssembly module also',
  'contains the following Rust crates. Their license notices follow the table.',
  '',
  '| Component | Version | License | Source |',
  '| --- | --- | --- | --- |',
  ...crates.map(
    (c) =>
      `| ${cell(c.name)} | ${cell(c.version)} | ${cell(c.license ?? 'see its notice')} | ${cell(c.repository ?? '')} |`,
  ),
  ...STD_PARTS.map(
    (p) =>
      `| Rust standard library: ${cell(p.name)} | ${rustRelease} | ${cell(p.license)} | ${p.repository} |`,
  ),
];

/**
 * The license expressions whose conditions the notices meet. A crate with any
 * other expression fails the build, so that a new license gets a decision.
 */
const KNOWN = new Set([
  'BSD-2-Clause',
  'BSD-3-Clause',
  'MIT',
  'Apache-2.0',
  'MIT OR Apache-2.0',
  '(MIT OR Apache-2.0) AND Unicode-3.0',
  '0BSD OR Apache-2.0',
]);
/** BSD clause 2, for crates that declare no license expression. */
const BSD_CLAUSE = /Redistributions in binary form must reproduce/i;
for (const c of crates) {
  const dir = dirname(c.manifest_path);
  const files = noticeFiles(c);
  const known =
    c.license === null
      ? files.some((f) => BSD_CLAUSE.test(readFileSync(join(dir, f), 'utf8')))
      : KNOWN.has(c.license);
  if (!known)
    throw new Error(`${c.name} ${c.version}: license ${c.license ?? 'file'} is not in KNOWN`);
  parts.push('', `## ${c.name} ${c.version}`, '', `- License: ${c.license ?? 'see its notice'}`);
  if (c.repository !== null) parts.push(`- Source: ${c.repository}`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8').trimEnd();
    parts.push('', `### ${f}`, '', codeBlock(text));
  }
}
for (const p of STD_PARTS) {
  const chosen = p.chosen === undefined ? '' : `, ${p.chosen} chosen`;
  parts.push(
    '',
    `## ${stdName(p)}`,
    '',
    `- License: ${p.license}${chosen}`,
    `- Source: ${p.repository}`,
  );
  for (const n of p.notices) parts.push('', `### ${n.title}`, '', codeBlock(stdNoticeText(n)));
}
writeFileSync(out, `${parts.join('\n')}\n`);
console.log(
  `  ${crates.length} crates, ${STD_PARTS.length} parts of the standard library → ${out}`,
);
