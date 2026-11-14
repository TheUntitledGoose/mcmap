#!/bin/sh
# M12b.13 pixel ownership, final measurement.
# `bar=0` keeps the animated stripe out of the framebuffer diffs; `budget` is a wall clock inside the page so
# a slow framing prints what it measured instead of dying silent; `seek` stands the playhead, because a fresh
# arm PLAYS and a moving draw range makes "is this claim drawn?" meaningless.
B=http://127.0.0.1:8765
run() { timeout 420 node tools/browser-probe.mjs "$1" --wait 15000 --eval-file build/q_ownersagree.js > "$2" 2>&1; }
run "$B/?goto=102,119,49&dist=20&time=1&timecls=0&gsec=3003&seek=3003&res=1&noautores&bar=0&n=45&budget=330" build/c1_agree_party.txt
run "$B/?goto=-40,72,-122&dist=45&time=1&timecls=0&caves=1&seek=112612&res=1&noautores&bar=0&n=45&budget=330" build/c1_agree_wall.txt
run "$B/?goto=-40,72,-122&dist=45&time=1&timecls=0&caves=1&seek=112612&res=1&noautores&bar=0&n=45&budget=330&markpick=2" build/c1_agree_wall_p2.txt
run "$B/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&gsec=93117&seek=93117&res=1&noautores&bar=0&n=45&budget=330" build/c1_agree_mine.txt
echo ALLDONE
