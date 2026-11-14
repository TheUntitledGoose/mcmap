#!/bin/sh
B=http://127.0.0.1:8765
run() { timeout 420 node tools/browser-probe.mjs "$1" --wait 15000 --eval-file build/q_ownersagree.js > "$2" 2>&1; }
Q="&res=1&noautores&bar=0&n=45&budget=330&tol=3"
run "$B/?goto=-40,72,-122&dist=45&time=1&timecls=0&caves=1&seek=112612$Q" build/c5_agree_wall.txt
run "$B/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&gsec=93117&seek=93117$Q" build/c5_agree_mine.txt
run "$B/?goto=102,119,49&dist=20&time=1&timecls=0&gsec=3003&seek=3003$Q" build/c5_agree_party.txt
echo ALLDONE
