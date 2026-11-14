#!/bin/sh
# M12b.13 evidence, second half: bodies per-body sight, the loading bar in a real pan,
# and the highlight still answering the second being drawn (not today).
run() {
  echo "=== $1 : $2"
  timeout 420 node tools/browser-probe.mjs "$2" --wait "${3:-15000}" --eval-file "$4" > "$1" 2>&1
  echo "exit $? -> $1"
}
run build/b22_seen.txt "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&gsec=3003&gat=104,119,47&res=1&noautores&bar=0" 15000 build/q_ghostseen.js
run build/b22_highlight.txt "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&vox=-40,70,-121&bar=0" 16000 build/q_m12b12.js
run build/b22_bar.txt "http://127.0.0.1:8765/?goto=102,119,49&dist=20&res=1&noautores" 12000 build/q_bar.js
run build/b22_bar_off.txt "http://127.0.0.1:8765/?goto=102,119,49&dist=20&res=1&noautores&bar=0" 12000 build/q_bar.js
