// SPDX-License-Identifier: 0BSD
// Adds a custom section to the start of a wasm module. Used by
// embed-notices.ts to put the license notices into the wasm.

/** The name of the custom section that holds the license notices. */
export const NOTICES_SECTION = 'license';
/** The magic number and version 1 that every wasm module starts with. */
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
/** The id of a custom section. */
const CUSTOM = 0;

/**
 * Encodes a number as unsigned LEB128, as wasm stores sizes.
 * @param n A whole number from 0 to 2^32 - 1.
 * @returns The bytes.
 * @throws {RangeError} For other numbers.
 */
export function leb128(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError(`not a u32: ${n}`);
  const out: number[] = [];
  do {
    const low = n % 0x80;
    n = Math.floor(n / 0x80);
    out.push(n === 0 ? low : low | 0x80);
  } while (n !== 0);
  return Uint8Array.from(out);
}

/**
 * Decodes an unsigned LEB128 number.
 * @param bytes The bytes.
 * @param at Where the number starts.
 * @returns The number and where the bytes after it start.
 * @throws {RangeError} If the number runs past the end or is longer than 5 bytes.
 */
export function readLeb128(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new RangeError('LEB128 number runs past the end');
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new RangeError('LEB128 number longer than 5 bytes');
}

/**
 * The name of the first section of a module, if it is a custom section.
 * @param wasm The module.
 * @returns The name, or `undefined`.
 */
function firstCustomName(wasm: Uint8Array): string | undefined {
  if (wasm[HEADER.length] !== CUSTOM) return undefined;
  const size = readLeb128(wasm, HEADER.length + 1);
  const name = readLeb128(wasm, size.next);
  return new TextDecoder().decode(wasm.subarray(name.next, name.next + name.value));
}

/**
 * Puts a custom section before every other section of a wasm module, where
 * a text viewer shows its content as the first lines of the file. Engines
 * ignore custom sections; `WebAssembly.Module.customSections()` reads them.
 * @param wasm The module.
 * @param name The section's name.
 * @param content The section's content.
 * @returns The module with the section.
 * @throws {Error} If `wasm` is not a wasm module of version 1, or already
 *   starts with a custom section of that name.
 */
export function withFirstSection(wasm: Uint8Array, name: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  if (wasm.length < HEADER.length || HEADER.some((b, i) => wasm[i] !== b)) {
    throw new Error('not a wasm module of version 1');
  }
  if (firstCustomName(wasm) === name) throw new Error(`the module already starts with a "${name}" section`);
  const nameBytes = new TextEncoder().encode(name);
  const nameSize = leb128(nameBytes.length);
  const size = leb128(nameSize.length + nameBytes.length + content.length);
  const parts = [wasm.subarray(0, HEADER.length), Uint8Array.of(CUSTOM), size, nameSize, nameBytes, content,
    wasm.subarray(HEADER.length)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
