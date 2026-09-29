// SPDX-License-Identifier: 0BSD
// How scripts/gen-licenses.ts shortens license notices for the JS banner.
import { describe, expect, it } from 'vitest';
import { MIT_NOTICE, MIT_POINTER, bannerLines, withoutApacheText, withoutMitText } from '../../scripts/notices.js';

/**
 * Wraps the words of a text at a given width, as crates do in their LICENSE files.
 * @param text The text.
 * @param width The maximum line length.
 * @param indent Put before each line.
 * @returns The wrapped text.
 */
function rewrap(text: string, width: number, indent = ''): string {
  return text
    .split('\n\n')
    .map((para) => {
      const lines: string[] = [];
      let line = '';
      for (const w of para.split(/\s+/)) {
        if (line !== '' && indent.length + line.length + 1 + w.length > width) {
          lines.push(indent + line);
          line = w;
        } else line = line === '' ? w : `${line} ${w}`;
      }
      return [...lines, indent + line].join('\n');
    })
    .join('\n\n');
}

describe('withoutMitText', () => {
  it('replaces the permission notice however its lines break', () => {
    for (const width of [60, 70, 72, 76, 79, 80, 100]) {
      for (const indent of ['', '    ']) {
        const text = `Copyright (c) 2020 Someone\n\n${rewrap(MIT_NOTICE, width, indent)}`;
        expect(withoutMitText(text), `${width} ${JSON.stringify(indent)}`).toBe(
          `Copyright (c) 2020 Someone\n\n${indent}${MIT_POINTER}`,
        );
      }
    }
  });

  it('replaces the line break before "THE SOFTWARE." that hyper and mio use', () => {
    const hyper = MIT_NOTICE.replace('DEALINGS IN THE\nSOFTWARE.', 'DEALINGS IN\nTHE SOFTWARE.');
    expect(hyper).not.toBe(MIT_NOTICE);
    expect(withoutMitText(hyper)).toBe(MIT_POINTER);
  });

  it('replaces every copy', () => {
    expect(withoutMitText(`A\n\n${MIT_NOTICE}\n\nB\n\n${rewrap(MIT_NOTICE, 72)}`)).toBe(
      `A\n\n${MIT_POINTER}\n\nB\n\n${MIT_POINTER}`,
    );
  });

  it('keeps a permission notice that is worded otherwise', () => {
    const other = MIT_NOTICE.replace('AUTHORS OR COPYRIGHT HOLDERS', 'COPYRIGHT HOLDERS');
    expect(withoutMitText(other)).toBe(other);
    const first = `${other}\n\n${MIT_NOTICE}`;
    expect(withoutMitText(first)).toBe(`${other}\n\n${MIT_POINTER}`);
  });
});

describe('withoutApacheText', () => {
  const apache = 'Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS FOR USE';
  const dashes = '-'.repeat(40);

  it('replaces a section that is the Apache License', () => {
    const text = `Intro\n${dashes}\n\n    ${apache}\n${dashes}\nMIT part`;
    expect(withoutApacheText(text)).toBe(
      `Intro\n${dashes}\n[The text of the Apache License, Version 2.0\nis in THIRD_PARTY_LICENSES.txt.]\n${dashes}\nMIT part`,
    );
  });

  it('names the LLVM exceptions when the section has them', () => {
    const text = `Intro\n${dashes}\n${apache}\n---- LLVM Exceptions to the Apache 2.0 License ----\n`;
    expect(withoutApacheText(text)).toContain('Version 2.0 and of the LLVM exceptions to it\n');
  });

  it('leaves a notice without sections alone', () => {
    expect(withoutApacheText(apache)).toBe(apache);
  });
});

it('bannerLines shortens both and splits into lines', () => {
  const dashes = '-'.repeat(40);
  expect(bannerLines(`Copyright\n\n${MIT_NOTICE}\n${dashes}\nApache License\nlong text`)).toEqual([
    'Copyright',
    '',
    MIT_POINTER,
    dashes,
    '[The text of the Apache License, Version 2.0',
    'is in THIRD_PARTY_LICENSES.txt.]',
    '',
  ]);
});
