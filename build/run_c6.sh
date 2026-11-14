#!/bin/sh
# The loading bar, measured as behaviour: it must appear when work is owed, hide when the page is settled,
# and mean "off" when told off (while the counters behind it keep running).
B=http://127.0.0.1:8765
timeout 200 node tools/browser-probe.mjs "$B/?goto=102,119,49&dist=1200&res=1&noautores" --wait 12000 --eval-file build/q_bar.js > build/c6_bar_on.txt 2>&1
timeout 200 node tools/browser-probe.mjs "$B/?goto=102,119,49&dist=1200&res=1&noautores&bar=0" --wait 12000 --eval-file build/q_bar.js > build/c6_bar_off.txt 2>&1
# Does a flush marker win the plane it shares with its own block? (`?timegrow` A/B, aimed-pixel honest.)
timeout 300 node tools/browser-probe.mjs "$B/?goto=-40,72,-122&dist=45&time=1&timecls=0&caves=1&seek=112612&res=1&noautores&bar=0&n=12" --wait 16000 --eval-file build/q_coplanar.js > build/c6_coplanar.txt 2>&1
timeout 300 node tools/browser-probe.mjs "$B/?goto=-40,72,-122&dist=45&time=1&timecls=0&caves=1&seek=112612&res=1&noautores&bar=0&n=12&timegrow=0.09" --wait 16000 --eval-file build/q_coplanar.js > build/c6_coplanar_grown.txt 2>&1
echo ALLDONE
