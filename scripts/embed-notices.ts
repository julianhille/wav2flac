// SPDX-License-Identifier: 0BSD
// Puts the license notices (THIRD_PARTY_LICENSES.txt) into the wasm, as its
// first section, so that they go wherever the wasm goes. Run by
// scripts/build.sh after wasm-opt, which would move the section to the end.
import { readFileSync, writeFileSync } from 'node:fs';
import { NOTICES_SECTION, withFirstSection } from './wasm-section.ts';

const [wasm, notices] = process.argv.slice(2);
if (wasm === undefined || notices === undefined)
  throw new Error('usage: embed-notices.ts <wasm> <notices file>');
writeFileSync(wasm, withFirstSection(readFileSync(wasm), NOTICES_SECTION, readFileSync(notices)));
console.log(`  ${notices} → the "${NOTICES_SECTION}" section of ${wasm}`);
