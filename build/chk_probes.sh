#!/bin/sh
# Syntax-check a browser probe the cheap way: wrap it the way tools/browser-probe.mjs does and let node
# parse it. A probe that fails to parse exits 2 after a full page boot - 90 s of nothing learned.
fail=0
for f in "$@"; do
  { echo '(async () => {'; cat "$f"; echo '})();'; } > build/.probecheck.mjs
  if node --check build/.probecheck.mjs 2>/dev/null; then echo "ok      $f"; else echo "BAD     $f"; node --check build/.probecheck.mjs 2>&1 | head -4; fail=1; fi
done
rm -f build/.probecheck.mjs
exit $fail
