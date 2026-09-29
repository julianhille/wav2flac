// SPDX-License-Identifier: 0BSD
// TypeDoc plugin: shows the type of `@throws {Type} text` tags. TypeDoc keeps
// the type (preservedTypeAnnotationTags) but typedoc-plugin-markdown doesn't
// render it, so move it into the text as "`Type`: text".
import { Converter } from 'typedoc';

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    for (const r of Object.values(context.project.reflections)) {
      for (const tag of r.comment?.blockTags ?? []) {
        if (tag.tag !== '@throws' || tag.typeAnnotation === undefined) continue;
        const type = tag.typeAnnotation.replace(/^\{|\}$/g, '').trim();
        tag.content = [{ kind: 'code', text: `\`${type}\`` }, { kind: 'text', text: ': ' }, ...tag.content];
        tag.typeAnnotation = undefined;
      }
    }
  });
}
