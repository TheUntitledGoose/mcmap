#!/bin/sh
# wait for the b17 batch to finish before loading another page (CPU contention changes settling)
while ! grep -c "^exit " build/b17_run.log | grep -q 5; do sleep 20; done
run() {
  echo "=== $5 : $1"
  timeout 480 node tools/browser-probe.mjs "$1" --wait "$2" --eval-file "$3" $4 > "$5" 2>&1
  echo "exit $? -> $5"
}
run "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&seek=3003&res=1&noautores&bar=0&n=45" 15000 build/q_ownersagree.js "" build/b18_agree_party.txt
run "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&bar=0&n=45" 16000 build/q_ownersagree.js "" build/b18_agree_wall.txt
run "http://127.0.0.1:8765/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&seek=93117&res=1&noautores&bar=0&n=45" 15000 build/q_ownersagree.js "" build/b18_agree_mine.txt
run "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&gsec=3003&gat=104,119,47&res=1&noautores&bar=0" 14000 build/q_ghostseen.js "" build/b18_seen.txt
run "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&vox=-40,70,-121&bar=0" 16000 build/q_m12b12.js "" build/b18_highlight.txt
run "http://127.0.0.1:8765/?goto=102,119,49&dist=20&res=1&noautores" 12000 build/q_bar.js "" build/b18_bar.txt
