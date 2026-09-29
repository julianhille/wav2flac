// SPDX-License-Identifier: 0BSD
// Shortens license notices for the `/*! @license */` banner of the JS bundles:
// the text of the Apache License and each copy of the MIT permission notice
// become pointers. Used by gen-licenses.ts.

/** A line of dashes, which the notices of compiler_builtins and libm put between their sections. */
const SECTION = /^-{20,}$/m;
/**
 * Replaces the text of the Apache License in a notice by a pointer to it, to
 * keep the banner short. The notices file has the text in full.
 * @param text A notice. Only a section of its own, between lines of dashes,
 *   is recognized as the Apache License.
 * @returns The notice for the banner.
 */
export function withoutApacheText(text: string): string {
  const separator = SECTION.exec(text)?.[0];
  if (separator === undefined) return text;
  return text.split(SECTION).map((s) => {
    if (!/^\s*Apache License\s*$/.test(s.trimStart().split('\n')[0] ?? '')) return s;
    const llvm = /LLVM Exceptions/.test(s) ? ' and of the LLVM exceptions to it' : '';
    return `\n[The text of the Apache License, Version 2.0${llvm}\nis in THIRD_PARTY_LICENSES.txt.]\n`;
  }).join(separator);
}
/**
 * The permission notice of the MIT license, as the SPDX license list and
 * choosealicense.com give it. The banner prints it once.
 */
export const MIT_NOTICE = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
/** A permission notice like the MIT one, from its first words to its last, however its lines break. */
const MIT_LIKE = /Permission\s+is\s+hereby\s+granted,\s+free\s+of\s+charge,[\s\S]*?DEALINGS\s+IN\s+THE\s+SOFTWARE\./g;
/** Stands in the banner for the permission notice. */
export const MIT_POINTER = '[The permission notice of the MIT License is at the end of this comment.]';
/**
 * The words of a text, whatever its line breaks and indentation.
 * @param t The text.
 * @returns The text with every run of whitespace as one space.
 */
const words = (t: string): string => t.replace(/\s+/g, ' ').trim();
/**
 * Replaces each copy of the MIT permission notice in a notice by a pointer to
 * the one copy at the end of the banner. A permission notice worded otherwise
 * (line breaks aside) is kept.
 * @param text A notice.
 * @returns The notice for the banner.
 */
export function withoutMitText(text: string): string {
  return text.replace(MIT_LIKE, (found) => {
    return words(found) === words(MIT_NOTICE) ? MIT_POINTER : found;
  });
}
/**
 * The lines of a notice as the banner prints them.
 * @param text A notice.
 * @returns The lines.
 */
export function bannerLines(text: string): string[] {
  return withoutMitText(withoutApacheText(text)).split('\n');
}
