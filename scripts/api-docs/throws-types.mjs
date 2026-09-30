// SPDX-License-Identifier: 0BSD
// TypeDoc plugin: shows the type of `@throws {Type} text` tags. TypeDoc keeps
// the type (preservedTypeAnnotationTags) but typedoc-plugin-markdown doesn't
// render it, so move it into the text as "`Type`: text". A union becomes
// "`A` or `B`", so no `|` can split a table cell.
import { Converter } from 'typedoc';

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    for (const r of Object.values(context.project.reflections)) {
      for (const tag of r.comment?.blockTags ?? []) {
        if (tag.tag !== '@throws' || tag.typeAnnotation === undefined) continue;
        const types = tag.typeAnnotation
          .replace(/^\{|\}$/g, '')
          .split('|')
          .map((t) => t.trim())
          .filter(Boolean);
        const type = types.flatMap((t, i) => [
          ...(i === 0 ? [] : [{ kind: 'text', text: i === types.length - 1 ? ' or ' : ', ' }]),
          { kind: 'code', text: `\`${t}\`` },
        ]);
        const hasText = tag.content.some((p) => p.text.trim() !== '');
        tag.content = hasText ? [...type, { kind: 'text', text: ': ' }, ...tag.content] : type;
        tag.typeAnnotation = undefined;
      }
    }
  });
}
