// SPDX-License-Identifier: 0BSD
// The Rust crates compiled into the wasm: normal dependencies for wasm32, not
// dev or build dependencies, and not proc macros (they only run at compile
// time), and the parts of the Rust standard library linked in with them.
// Shared by gen-licenses.ts and gen-third-party.ts.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A package as `cargo metadata` describes it. */
export interface Package {
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

/**
 * The crates linked into the wasm, sorted by name.
 * @returns The packages.
 */
export function shippedCrates(): Package[] {
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
  return [...seen].map((id) => packages.get(id)!).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The rustc version the wasm is built with.
 * @returns E.g. `1.98.1`.
 */
export function rustVersion(): string {
  return /^rustc (\S+)/.exec(execFileSync('rustc', ['--version'], { encoding: 'utf8' }))?.[1] ?? 'unknown';
}

/** A license text of a part of the Rust standard library. */
export interface StdNotice {
  /** The name of the file in its source tree. */
  title: string;
  /** The copy of it in scripts/std-licenses/. */
  file: string;
  /** Whether the JS banner reproduces it (without the Apache-2.0 text). */
  banner: boolean;
}
/** A part of the Rust standard library that is linked into the wasm. */
export interface StdPart {
  name: string;
  /** SPDX expression. */
  license: string;
  /** The license taken where the expression offers a choice. */
  chosen?: string;
  repository: string;
  notices: StdNotice[];
}

/**
 * The parts of the Rust standard library that the linker keeps in the wasm.
 * cargo does not list them, so they are written down here. To check the list,
 * build with `CARGO_PROFILE_RELEASE_STRIP=false` and read the crate names in
 * the wasm's name section. The license texts in scripts/std-licenses/ come
 * from the Rust release in rust-toolchain.toml (see the README.md there);
 * compare them again when the toolchain changes.
 */
export const STD_PARTS: StdPart[] = [
  {
    // core carries tables generated from the Unicode Character Database.
    name: 'core, alloc, std',
    license: '(MIT OR Apache-2.0) AND Unicode-3.0',
    chosen: 'MIT',
    repository: 'https://github.com/rust-lang/rust',
    notices: [
      { title: 'LICENSE-MIT', file: 'rust-LICENSE-MIT', banner: true },
      { title: 'LICENSES/Unicode-3.0.txt', file: 'Unicode-3.0.txt', banner: false },
    ],
  },
  {
    name: 'dlmalloc',
    license: 'MIT OR Apache-2.0',
    chosen: 'MIT',
    repository: 'https://github.com/alexcrichton/dlmalloc-rs',
    notices: [{ title: 'LICENSE-MIT', file: 'dlmalloc-LICENSE-MIT', banner: true }],
  },
  {
    // Integer and float helpers, and the math functions of its libm.
    name: 'compiler_builtins, libm',
    license: 'MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)',
    repository: 'https://github.com/rust-lang/compiler-builtins',
    notices: [
      { title: 'LICENSE.txt', file: 'compiler-builtins-LICENSE.txt', banner: true },
      { title: 'libm/LICENSE.txt', file: 'libm-LICENSE.txt', banner: true },
    ],
  },
];

/**
 * The name of a part of the standard library, as the notices print it.
 * @param part The part.
 * @returns E.g. `Rust standard library 1.98.1: core, alloc, std`.
 */
export function stdName(part: StdPart): string {
  return `Rust standard library ${rustVersion()}: ${part.name}`;
}

/**
 * Reads a license text from scripts/std-licenses/.
 * @param notice The notice.
 * @returns Its text, without trailing whitespace.
 */
export function stdNoticeText(notice: StdNotice): string {
  return readFileSync(join(import.meta.dirname, 'std-licenses', notice.file), 'utf8').trimEnd();
}
