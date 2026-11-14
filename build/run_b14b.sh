#!/bin/sh
run() { # url wait evalfile extraflags log
  echo "=== $5 : $1"
  timeout 480 node tools/browser-probe.mjs "$1" --wait "$2" --eval-file "$3" $4 > "$5" 2>&1
  echo "exit $? -> $5"
}
run "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&gsec=3003&gat=104,119,47&res=1&noautores&bar=0&n=25" 15000 build/q_ownersagree.js "" build/b15_agree_party.txt
run "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&rows=41065&bar=0&n=25" 16000 build/q_ownersagree.js "" build/b15_agree_wall.txt
run "http://127.0.0.1:8765/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&gsec=93117&gat=66,99,-48&res=1&noautores&bar=0&n=25" 15000 build/q_ownersagree.js "" build/b15_agree_mine.txt
run "http://127.0.0.1:8765/?goto=102,119,49&dist=20&res=1&noautores&bar=0" 12000 build/q_bar.js "" build/b15_bar_off.txt
