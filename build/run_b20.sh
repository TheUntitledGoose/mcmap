#!/bin/sh
# M12b.13 pixel-honesty A/B, third pass: real chunk ground decides what buries a marker,
# a coplanar tie belongs to a cube marker, a cutout sprite that the alpha test throws away
# stops answering, and no click may answer a claim the playhead has not drawn.
run() {
  echo "=== $1 : $2"
  timeout 420 node tools/browser-probe.mjs "$2" --wait "${3:-15000}" --eval-file build/q_ownersagree.js > "$1" 2>&1
  echo "exit $? -> $1"
}
run build/b20_agree_party.txt "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&seek=3003&res=1&noautores&bar=0&n=45"
run build/b20_agree_wall.txt "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&bar=0&n=45"
run build/b20_agree_mine.txt "http://127.0.0.1:8765/?goto=66,99,-48&dist=20&time=1&timecls=0&caves=1&seek=93117&res=1&noautores&bar=0&n=45"
# The remaining marker pixels that the frame does not paint: is the atlas MIP chain averaging a
# sprite's alpha under alphaTest at that distance? mipmax=0 forbids levels above 0.
run build/b21_wall_nomip.txt "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores&seek=112612&bar=0&n=45&mipmax=0" 18000
