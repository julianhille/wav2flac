// SPDX-License-Identifier: 0BSD
// The Rust crates compiled into the wasm: normal dependencies for wasm32, not
// dev or build dependencies, and not proc macros (they only run at compile
// time). Shared by gen-licenses.ts and gen-third-party.ts.
import { execFileSync } from 'node:child_process';

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

/** The Rust standard library as linked into every wasm32 build. */
export const RUST_STD_PARTS = 'core, alloc, std, dlmalloc';
