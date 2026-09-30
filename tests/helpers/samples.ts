// SPDX-License-Identifier: 0BSD
// Runs the code samples of the docs as they are printed.
import { readFileSync } from 'node:fs';

/**
 * Returns the ```js blocks of a Markdown file.
 * @param path The file.
 * @param count How many blocks the tests expect.
 * @returns The code of each block.
 */
export function jsBlocks(path: string, count: number): string[] {
  const md = readFileSync(path, 'utf8');
  const blocks = [...md.matchAll(/^```js\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');
  if (blocks.length !== count) throw new Error(`${path}: ${blocks.length} js blocks, expected ${count}`);
  return blocks;
}

/**
 * Turns a sample module into a script: drops its imports and `export`s.
 * @param code The sample.
 * @returns The code without imports.
 */
export function asScript(code: string): string {
  return code.replace(/^import .* from 'wav2flac';$/gm, '').replace(/^export /gm, '');
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/**
 * Runs `code` as the body of an async function.
 * @param code The body.
 * @param scope Names and values the body can use.
 * @returns What the body returns.
 */
export function run(code: string, scope: Record<string, unknown>): Promise<unknown> {
  return new AsyncFunction(...Object.keys(scope), code)(...Object.values(scope));
}
