#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD
# Fails if any Rust source line (tracked, or new and not ignored) is longer
# than rustfmt's max_width.
# Stable rustfmt leaves lines it cannot wrap (long string literals, comments,
# macro calls) untouched without reporting them; this closes that gap.
set -euo pipefail
cd "$(dirname "$0")/.."
max=$(sed -n 's/^max_width *= *\([0-9]*\).*/\1/p' rustfmt.toml)
max=${max:-100}
export MAX=$max
# perl counts characters (not bytes) the same everywhere; awk's length() does not.
git ls-files -z --cached --others --exclude-standard -- '*.rs' | xargs -0 -r perl -CSD -ne '
  if (length($_) - /\n\z/ > $ENV{MAX}) {
    printf "%s:%d: %d chars (max %d)\n", $ARGV, $., length($_) - /\n\z/, $ENV{MAX};
    $bad = 1;
  }
  close ARGV if eof;
  END { exit $bad }
' || { echo "error: lines exceed $max characters; shorten them (rustfmt cannot)" >&2; exit 1; }
