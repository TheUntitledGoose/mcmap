#!/bin/sh
# M12b.13 pixel honesty, budgeted run: 25 pixels per framing (the ray over a 6.4 M-vert scene is the cost),
# and the probe now reports partial results if it runs out of wall clock instead of timing out silently.
run() {
  echo "=== $1 : $2"
  timeout 460 node tools/browser-probe.mjs "$2" --wait "${3:-15000}" --eval-file build/q_ownersagree.js > "$1" 2>&1
  echo "exit $? -> $1"
}
B="&n=25&budget=330"
run build/b24_agree_party.txt "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&seek=3003&res=1&noautores&bar=0$B"
run build/b24_agree_wall.txt "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&bar=0$B"
run build/b24_agree_mine.txt "http://127.0.0.1:8765/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&seek=93117&res=1&noautores&bar=0$B"
run build/b25_wall_nomip.txt "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&bar=0$B&mipmax=0"
