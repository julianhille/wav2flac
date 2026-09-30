// SPDX-License-Identifier: 0BSD
// TypeDoc plugin: fails the build when a documented type is `any`. TypeDoc
// runs with skipErrorChecking, because the docs build has no wasm-bindgen
// glue (build/bindgen/). A type inferred through the glue would then be
// published as `any` without an error; this turns that into one.
import { Converter } from 'typedoc';

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    for (const r of Object.values(context.project.reflections)) {
      const type = r.type?.toString();
      if (type !== undefined && /\bany\b/.test(type)) {
        app.logger.error(
          `${r.getFullName()} is documented as \`${type}\`. Give it an explicit type in ts/; ` +
            'the docs build has no wasm-bindgen glue to infer it from.',
        );
      }
    }
  });
}
