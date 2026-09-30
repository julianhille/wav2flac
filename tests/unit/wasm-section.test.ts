// SPDX-License-Identifier: 0BSD
// How scripts/embed-notices.ts puts the license notices into the wasm.
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NOTICES_SECTION, leb128, readLeb128, withFirstSection } from '../../scripts/wasm-section.js';

const wasm = Uint8Array.from(readFileSync('build/bindgen/wav2flac_bg.wasm'));

describe('leb128', () => {
  it('encodes as the wasm spec does', () => {
    expect([...leb128(0)]).toEqual([0]);
    expect([...leb128(127)]).toEqual([0x7f]);
    expect([...leb128(128)]).toEqual([0x80, 0x01]);
    expect([...leb128(624485)]).toEqual([0xe5, 0x8e, 0x26]);
    expect([...leb128(0xffff_ffff)]).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f]);
  });

  it('decodes what it encodes, from any offset', () => {
    fc.assert(fc.property(fc.nat({ max: 0xffff_ffff }), fc.uint8Array({ maxLength: 4 }), (n, before) => {
      const bytes = Uint8Array.from([...before, ...leb128(n), 0xff]);
      expect(readLeb128(bytes, before.length)).toEqual({ value: n, next: bytes.length - 1 });
    }));
  });

  it('rejects numbers that are not a u32', () => {
    for (const n of [-1, 0.5, 2 ** 32, Number.NaN]) expect(() => leb128(n)).toThrow(RangeError);
  });

  it('rejects a number that runs past the end or is too long', () => {
    expect(() => readLeb128(Uint8Array.of(0x80, 0x80), 0)).toThrow(/past the end/);
    expect(() => readLeb128(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x00), 0)).toThrow(/longer than 5/);
  });
});

describe('withFirstSection', () => {
  it('puts the section first, where it is readable, and keeps the module as it was', () => {
    // Long enough for a size of three LEB128 bytes.
    const text = `Third-party software\n${'Copyright © Someone\n'.repeat(1000)}`;
    const out = withFirstSection(wasm, NOTICES_SECTION, new TextEncoder().encode(text));
    expect(out.subarray(0, 8)).toEqual(wasm.subarray(0, 8));
    expect(out[8]).toBe(0);
    const size = readLeb128(out, 9);
    expect(size.next - 9).toBe(3);
    expect(new TextDecoder().decode(out.subarray(size.next, size.next + 1 + NOTICES_SECTION.length + 20)))
      .toBe(`\u0007${NOTICES_SECTION}Third-party software`);
    expect(out.subarray(size.next + size.value)).toEqual(wasm.subarray(8));

    const mod = new WebAssembly.Module(out);
    const [section, ...more] = WebAssembly.Module.customSections(mod, NOTICES_SECTION);
    expect(more).toEqual([]);
    expect(new TextDecoder().decode(section)).toBe(text);
    expect(WebAssembly.Module.exports(mod)).toEqual(WebAssembly.Module.exports(new WebAssembly.Module(wasm)));
  });

  it('takes an empty section', () => {
    const out = withFirstSection(wasm, NOTICES_SECTION, new Uint8Array());
    const [section] = WebAssembly.Module.customSections(new WebAssembly.Module(out), NOTICES_SECTION);
    expect(section?.byteLength).toBe(0);
  });

  it('rejects what is not a wasm module of version 1', () => {
    for (const bytes of [new Uint8Array(), wasm.subarray(0, 7), Uint8Array.of(0, 0x61, 0x73, 0x6d, 2, 0, 0, 0)]) {
      expect(() => withFirstSection(bytes, NOTICES_SECTION, new Uint8Array())).toThrow(/not a wasm module/);
    }
  });

  it('rejects a module cut off inside a section', () => {
    expect(() => withFirstSection(wasm.subarray(0, 100), NOTICES_SECTION, new Uint8Array())).toThrow(
      /runs past the end/,
    );
  });

  it('refuses to add the section twice', () => {
    const once = withFirstSection(wasm, NOTICES_SECTION, Uint8Array.of(0x41));
    expect(() => withFirstSection(once, NOTICES_SECTION, Uint8Array.of(0x41))).toThrow(/already has/);
    // Also where wasm-opt leaves it: at the end.
    const atEnd = Uint8Array.from([...wasm, ...once.subarray(8, once.length - wasm.length + 8)]);
    expect(WebAssembly.Module.customSections(new WebAssembly.Module(atEnd), NOTICES_SECTION)).toHaveLength(1);
    expect(() => withFirstSection(atEnd, NOTICES_SECTION, Uint8Array.of(0x41))).toThrow(/already has/);
    // A first custom section with another name is fine.
    expect(() => withFirstSection(withFirstSection(wasm, 'other', new Uint8Array()), NOTICES_SECTION, new Uint8Array()))
      .not.toThrow();
  });
});
