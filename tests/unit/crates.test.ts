// SPDX-License-Identifier: 0BSD
// Which files scripts/gen-licenses.ts reads as a crate's license notices.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Package, noticeFiles } from '../../scripts/crates.js';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true });
  dir = undefined;
});

/**
 * A crate directory with the given files and directories.
 * @param files File paths, with `/`.
 * @param dirs Directory paths, created before the files.
 * @param licenseFile The manifest's `license-file`.
 * @returns The crate.
 */
function crate(files: string[], dirs: string[] = [], licenseFile: string | null = null): Package {
  dir = mkdtempSync(join(tmpdir(), 'crate-'));
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ['Cargo.toml', ...files]) writeFileSync(join(dir, f), 'x');
  return {
    name: 'c',
    version: '1.0.0',
    license: null,
    license_file: licenseFile,
    manifest_path: join(dir, 'Cargo.toml'),
  } as Package;
}

describe('noticeFiles', () => {
  it('lists the notice files, sorted, and no directories', () => {
    const c = crate(
      ['README.md', 'LICENSE-MIT', 'COPYRIGHT', 'NOTICE', 'LICENSE-APACHE'],
      ['LICENSES', 'licenses-extra', 'docs'],
    );
    expect(noticeFiles(c)).toEqual(['COPYRIGHT', 'LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE']);
  });

  it('lists the files in a license directory, as in the REUSE layout', () => {
    const c = crate(
      ['AUTHORS', 'LICENSES/MIT.txt', 'LICENSES/extra/BSD-3-Clause.txt', 'docs/LICENSE'],
      ['LICENSES/extra', 'docs'],
    );
    expect(noticeFiles(c)).toEqual([
      'AUTHORS',
      'LICENSES/MIT.txt',
      'LICENSES/extra/BSD-3-Clause.txt',
    ]);
  });

  it('adds the license-file of the manifest once', () => {
    expect(noticeFiles(crate(['LICENSE'], [], './LICENSE'))).toEqual(['LICENSE']);
    expect(noticeFiles(crate(['LICENSE'], [], 'legal/terms.txt'))).toEqual([
      'LICENSE',
      'legal/terms.txt',
    ]);
  });

  it('fails for a crate without one', () => {
    expect(() => noticeFiles(crate(['README.md'], ['LICENSES']))).toThrow(/no license file/);
  });
});
