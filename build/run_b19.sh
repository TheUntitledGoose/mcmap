#!/bin/sh
while [ "$(grep -c '^exit ' build/b18_run.log)" -lt 6 ]; do sleep 20; done
run() {
  echo "=== $5 : $1"
  timeout 480 node tools/browser-probe.mjs "$1" --wait "$2" --eval-file "$3" $4 > "$5" 2>&1
  echo "exit $? -> $5"
}
run "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&seek=3003&res=1&noautores&bar=0&n=45" 15000 build/q_ownersagree.js "" build/b19_agree_party.txt
run "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&bar=0&n=45" 16000 build/q_ownersagree.js "" build/b19_agree_wall.txt
run "http://127.0.0.1:8765/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&seek=93117&res=1&noautores&bar=0&n=45" 15000 build/q_ownersagree.js "" build/b19_agree_mine.txt
