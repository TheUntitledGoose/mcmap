# worldd — a browser map viewer for a modded Minecraft Java save

Point it at a live server root (`world/` plus its `mods/`), bake once, and a whole
dimension renders in a WebGL2 page: the entire overworld at once, plus the nether, the
end and any custom dimension folder the save has. Walk it in first person, or fly it in
orbit. Pan, and it re-resolves the picture; keep zoomed-out chunks if you want.

Two rules decide the whole design:

* **The browser renders, Node decodes.** A 3.6 GB save with 284,239 present chunks is not
  something a page can NBT-parse. Node reads region files, decodes chunk sections into a
  compact binary voxel payload, and the page meshes it (in worker threads).
* **The page holds voxel truth, not pre-baked geometry.** That is why X-ray, block
  filters, per-player attribution and lighting are page-side features and not new bakes.

Everything measured in this repo — every number in `HANDOFF.md` — came from a probe or a
`build/dbg-*.mjs` script that is committed, so a claim can be re-run after a disk incident.

---

## What this is not

* **Not a static site.** The page needs `worldd` (Node) next to the save: chunk payloads,
  shell/LOD packs, coverage and ledger queries are all served requests. Serving `web/`
  from nginx alone gets you a blank canvas.
* **Not a git checkout of your world.** `DarkRPG/` (the save, the mod jars, the crash
  logs, the copy of the Mojang client jar) is **ignored and untracked**: 3.6 GB of data
  that is not ours to redistribute. `--world <dir>` is a flag, not a constant.
* **Not an official renderer.** Textures and block models come out of *your own* 1.20.1
  client jar and the save's own mod jars. Nothing Mojang-owned is committed here.

---

## Layout

```
server/     Node: census, asset packer, payload decoder, worldd HTTP server, bakes
shared/     constants and formats shared by Node and the page (chunk, shell, LOD, ledger,
            pool split, view policy, player physics, region coverage bits)
web/        the page. No bundler, no framework: ESM + three.js
  js/       renderer, mesher, stores, lighting, collision — DOM-free and three-free where
            possible, so they are unit-testable in Node
tools/      dev tools: region reader, column/surface probes, browser probe, patcher
tests/      node --test suites (323 as of 9.26). The logic layers are covered; visual
            correctness is proved by framebuffer probes
build/      DERIVED. Never committed except the probes that produced the numbers
  census.json          block-state census of the save
  assets/              atlas.png, atlas.json, geometry.bin          ~3.6 MB
  shells/              per-region shell + overview packs (653 files) ~63 MB
  lods/                pre-baked coarse tiles, cells 16/8/4          ~90 MB
  ledger/              block-history export + per-dimension packs    ~34 MB
  cache/               decoded chunk payload cache; runtime-derived, pruned by budget,
                       deletable at any time — do not ship it
```

`main.js` in the repo root is a historical artifact (the file recovered during the
near-loss incident). The live renderer is `web/js/main.js`.

---

## Requirements

| | |
|---|---|
| Node | 18 or newer (`node --test`, `AbortSignal.timeout`, `node:zlib`). The runtime is pinned in `tools/serve-worldd.cmd` for Windows |
| npm packages | `three` at runtime (served from `node_modules/three/build` via `/vendor/`). `ws` is only used by `tools/browser-probe.mjs` |
| Python | 3, only for `tools/ledger-export.py` (reads `world/ledger.sqlite`). Nothing else needs it, and Node never opens that SQLite file |
| Assets | your own `versions/<ver>/<ver>.jar` (`VANILLA_JAR=`) and the save's `mods/*.jar` (`SERVER_ROOT=`) |
| Disk | save 3.6 GB, derived packs ~190 MB, payload cache grows to its budget (default 60,000 files) |

---

## Quickstart (the machine that already has the save)

```bash
npm install                        # three (+ ws for the probes)

# 1. census: what block states actually exist in this save
npm run census -- /srv/DarkRPG/world

# 2. assets: atlas + baked model geometry out of your jar and the save's mods
SERVER_ROOT=/srv/DarkRPG VANILLA_JAR="$HOME/.minecraft/versions/1.20.1/1.20.1.jar" \
  npm run pack:assets

# 3. far view: per-region shell/overview packs, then the coarse LOD rungs
npm run bake:shells -- --world /srv/DarkRPG/world     # ~11 min, ~63 MB
npm run bake:lod    -- --world /srv/DarkRPG/world     # per rung, additive; ~90 MB total

# 4. optional: block history ("who placed this")
npm run bake:ledger:full -- --world /srv/DarkRPG/world   # export + pack, seconds

# 5. serve
npm run serve                      # 0.0.0.0:8765  (dev box)
npm run serve:local                # 127.0.0.1:8765 (behind a proxy — see Deploy)
```

Then open `http://127.0.0.1:8765/`. `?debug=1` brings back the instrument panel, `H`
toggles it at any time.

Windows: `tools\serve-worldd.cmd 8765` starts a *supervised* listener — it pins the Node
binary, logs to `logs/`, and restarts on crash without treating a user stop as a crash
loop. That is the long-lived entry point; `npm run serve` is the dev one.

---

## Deploy

### What the server needs

| What | Path | Size (DarkRPG) |
|---|---|---|
| source | `server/ shared/ web/ tools/` | ~1.3 MB |
| baked far view | `build/assets build/shells build/lods` | ~157 MB |
| block history (optional) | `build/ledger/*.ledpack` + `meta.json` | ~2.5 MB (skip `actions.bin`, 32 MB, it is a build input) |
| player skins (optional) | `build/skins/` | ~0.2 MB; fetched once by `node tools/fetch-skins.mjs`, never by the browser |
| the save itself | `world/` (only `region/`, `DIM*/region/`, `dimensions/*/region/`, `level.dat`, `data/`, `poi/` are read) | 2.6 GB for this overworld |
| payload cache | `build/cache` | do **not** ship; it rebuilds itself |

The save is not optional: the page asks for chunk payloads on demand. If the webserver
cannot hold 2.6 GB of region files, it cannot serve the viewer — baking does not remove
that requirement, it only removes the far-view decode cost.

`node tools/deploy-pack.mjs` (or `npm run deploy:check`) verifies this list, prints the
sizes, names anything stale or missing, and stages the small part:

```bash
node tools/deploy-pack.mjs --world /srv/DarkRPG/world --stage deploy/
# prints the rsync/tar commands for the big parts, and refuses to stage build/cache
```

### Container (Docker, Portainer)

There is a `Dockerfile` and a `compose.yaml`. The container is the same `worldd`, configured
through the environment instead of a command line, because that is the thing a Portainer stack
screen can actually show and edit:

| Variable | Flag | Image default |
|---|---|---|
| `WD_WORLD` | `--world` | `/data/DarkRPG/world` |
| `WD_CACHE` | `--cache` | `/data/cache` |
| `WD_CACHE_MAX_GB` | `--cache-max-gb` | `6` |
| `WD_HOST` / `WD_PORT` | `--host` / `--port` | `0.0.0.0` / `8765` |
| `WD_PACKS` / `WD_LODS` / `WD_LEDGER` / `WD_ASSETS` | `--packs` … | `/srv/app/build/…` |
| `WD_SKINS` | `--skins` | `/srv/app/build/skins` (`none` turns the pack off) |
| `WD_SLOW_MS` / `WD_HEARTBEAT` | `--slow-ms` / `--heartbeat` | `400` / `60` |

Any `WD_*` that is not one of those flags **stops the boot with exit 2** and prints the real flag
list. A mistyped `WD_WROLD` in a stack screen otherwise becomes "I mounted the save and the map is
still empty", which is the worst kind of quiet.

```bash
docker build -t mcmap .
docker run -d --name mcmap -p 8765:8765 \
  -v /srv/DarkRPG:/data/DarkRPG:ro \
  -v mcmap-cache:/data/cache mcmap
```

or, in Portainer, *Stacks → New stack → paste `compose.yaml`*. Two decisions in that file are
load-bearing:

* **The save is a read-only mount, not an image layer.** It is ~3 GB and it is a living directory;
  a copy inside an image is a copy that silently goes stale, and the container has no business
  writing to a world.
* **The derived packs are image layers.** `build/assets` (3.6 MB), `build/shells` (63 MB),
  `build/lods` (90 MB) and `build/ledger` without `actions.bin` (11 MB) — about 168 MB —
  are re-baked by hand, cost about an hour, and change far less often than
  the save. Shipping them in the image is what makes a fresh container useful in ten seconds.
  `build/cache` is the opposite: never shipped, regenerated, swept against `WD_CACHE_MAX_GB` on boot.

**The packs are not in git.** A fresh clone has no `build/assets`, and the image build stops in a
preflight that says so, because a container that starts without them serves a world with holes where
the far view should be and no error. Bake first, on a machine holding the save and the game jars:

```bash
npm run bake          # census, assets, shells, LOD rungs
npm run bake:ledger   # block history, if you want the time machine
node tools/fetch-skins.mjs  # the cast's skins, if you want them: one Mojang call per
                      # playerdata UUID, and it stops rather than inventing a face for a
                      # name with no profile (the strip's white cell does that honestly)
docker build -t mcmap .
```

**Health check and the boot sweep.** The health check is `GET /stats`, and the start period is
300 s. The sweep at boot runs before the port opens: on a current cache it is cheap (measured: 1 s to
the first `/stats` over a 627,579-file / 1.4 GB cache), but a volume left by an **older build** is
measured and then deleted whole, and that walk alone costs ~77 s for 627k files. `/stats` does not
answer until that finishes, so with `restart: unless-stopped` and a short start period the container
is killed mid-chore and comes back sweeping — a loop that looks like a crash. The first deploy of a
volume that already holds a cache is the case to give room. `WD_CACHE=none` removes both the sweep and
the cache.

**No auth, same as ever.** What this serves is the entire map of a private save plus player names.
On `0.0.0.0` inside a compose network that is fine for a LAN/VPN; anything reachable from the
internet needs the proxy in front (section below) with TLS and a login, or a WireGuard interface.

**If your build host has no docker binary** (this repo's development box is one), the part of the
image contract that breaks in the field can still be checked:

```bash
node tools/sim-container.mjs        # stages exactly the COPY set, boots from it with only WD_* env
```

It boots the staged tree from that tree as its only cwd and hits every route the browser uses; a
pack path that no longer matches the code, or a relative path that only works from the repo root,
fails there instead of three days later as a hole in the far view.

### Ship it

```bash
# small part: source + derived packs (staged by deploy-pack.mjs)
rsync -a --delete deploy/            you@webserver:/srv/worldd/

# big part: the save (or a subset of dimensions you actually want public)
rsync -a DarkRPG/world/              you@webserver:/srv/worldd/world/
```

`build/cache` is excluded by design; a fresh cache costs decode time, not correctness.
Cache files are keyed by a state-table tag and light generation, so a mismatched cache is
ignored rather than mis-rendered.

### Run it behind a proxy (the recommended shape)

```bash
node server/worldd.mjs --world /srv/worldd/world --host 127.0.0.1 --port 8765
```

Bind `127.0.0.1`. There is no auth in `worldd`, and what it serves is the entire map of a
private multiplayer save, including player names through the block-history overlay. Put
the proxy in front and make it do TLS and authentication:

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # worldd gzips response bodies itself (level 1 for payload, 9 for json);
    # do not let nginx gzip them a second time
    gzip off;
    proxy_read_timeout 120s;          # a 64x64 shell block is ~10 MB of body
}
location ~ ^/(vendor|assets|shells|lods)/ {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Cache-Control "public, max-age=86400";
}
```

Caddy: `reverse_proxy 127.0.0.1:8765` and leave encoding to worldd.

Supervision (Linux):

```ini
# /etc/systemd/system/worldd.service
[Service]
WorkingDirectory=/srv/worldd
ExecStart=/usr/bin/node server/worldd.mjs --world /srv/worldd/world --host 127.0.0.1 --port 8765
Restart=always
Environment=NODE_OPTIONS=--max-old-space-size=2048
```

Keep `--heartbeat 60` on (the default): the process logs a beat, an in-flight request
table, event-loop lag and a listener backpressure reading. When a port stops answering,
those three numbers are the difference between "dead", "wedged" and "merely slow" — that
distinction has already cost two debugging sessions to learn the hard way.

### Serving a save that keeps changing

* The payload cache is invalidated by comparing cache mtime to region-file mtime, so live
  edits are picked up. Region coverage (`/regions`) is re-listed on a TTL (30 s), not
  remembered from boot.
* Baked far view is **not** incremental per chunk: after real terrain edits, re-run
  `bake:shells` and `bake:lod` for the affected dimensions.
* Block history needs `bake:ledger` again (the pack refuses to serve if the export is
  newer than the pack).

---

## Controls

Orbit: drag to rotate, wheel to zoom, right-drag to pan. `V` switches to walk mode
(real body: gravity, collision, jumping — WASD, Space, Shift, Ctrl), `F` free-flight.

While the time machine is armed, `<` and `>` step the playhead **one logged change** at a time (the bare
`,` and `.` keys work too, because `<` and `>` need Shift and a key nobody can press without another key is
a key nobody finds), `B` puts the camera on the nearest standing person — or says why nobody stands at this
second — and `Esc` gives the camera back.
`H` instruments, `?` help, `T` ask about the block under the crosshair, click a block in
orbit mode for its block history card. With the time machine on, a stand-in figure stands
where each player's hand acted: click the figure, or the name tag over it, for what the log
actually says about that person (the tag is the part that stays reachable when rock is in
front of them, and "only this player's edits" is a button inside that card, not a click away). A name
label never leaves the picture: it slides along the frame when its person stands near an edge, and it
disappears instead of half-rendering off the window — the panel row counts why (too small to see, or off
this view).

Scrubbing back draws what the log claims had happened **by that second**: a block broken at second 92,291 and
re-skinned at 167,880 still draws the 92,291 block at everything between, a face counts as inside the players'
own build only once the voxel behind it has been claimed *yet*, and a click answers that block rather than
today's terrain. What the layer could not draw is said out loud under the count — a name this atlas has no
model for, a claim buried inside the build at this second — instead of quietly drawing less. And a click can
only answer a change the playhead has actually drawn: the ray reads the whole filter buffer while
`setDrawRange` shows the part that has happened by this second, so an undrawn (future) claim is filtered out
before the newest-claim tie-break.

Everyday settings live in the panel (nine rows plus three collapsed groups). Every panel
row also has a URL parameter, so a view is a link:

```
?radius=16            close-detail ceiling, chunks
?detailpixels=0       sharp-detail by pixels (default on) vs by the slider
?caves=1              mesh unlit/cave geometry
?darkcut=8            drop faces with no light (cheap, and it hides caves)
?groundfar=0          keep treetops at coarse distance
?nocaps=1 / ?capdrop=6  baked cap policy
?noaa / ?aa=1         multisample (context flag: it is chosen at boot, not live)
?res=1.5              draw resolution (supersampling above 1); ?noautores pins it (probes do this)
?nolod                no baked far world at all: the live far grid draws the distance instead
?lodquality=60        how coarse the far world may get (100 = 16-block columns at the horizon)
?lodverts=4e6         the vertex budget the far layer is allowed to spend
?lodhide=0            submit baked tiles the coverage clip would kill entirely, instead of skipping
                      them at the draw call (the skip is measured pixel-identical: see HANDOFF M17)
?ledger=1             block-history overlay; ?ledgerwho=, ?ledgercls=, ?ledgermin=
?time=1               the time machine; ?timecls=2 (kind), ?timeplay=0 (paused),
                      ?timelook=blocks|plates|tiles, ?timegeommb=384 (the ceiling a block-shaped
                      replay may reach; 336 MB is what this dimension's any-change filter costs as
                      blocks, and below that it steps down to flat plates), ?timegrow=0 (put the
                      markers flush with their voxel), ?timetiles=0,
                      ?timeterrain=0 (undo the log in the voxels), ?timesharp=12 (replay in a wider
                      square than the view draws sharp), ?timestack=1 (nest older claims at one voxel
                      outside the newest; by default every claim draws, each at its own voxel),
                      ?timededupe=1 (draw one cube per voxel instead: honest only with the playhead at the
                      end of the filter, because the newest claim may be a second you have not reached),
                      ?timecull=1 (default: a face is inside the players' own build only once the voxel
                      behind it has been claimed as of the second being drawn), ?timecull=2 (the old
                      whole-filter rule - cheaper, and it hid 118,954 faces of standing blocks plus 1,817
                      whole claims on the place filter alone), ?timecull=0 (draw every face)
                      ?hover=0, ?timepick=0 (let the outline answer today's mesh again)
?bodies=0             stop standing the players back in (it comes on with the time machine)
?bodygap=300          the silence, in seconds, that ends a body. Measured on this save: one
                      player's hand actions sit 1 s apart at p50, but across a silence over
                      300 s the hand has already moved a median 52-155 blocks - so five minutes
                      of nothing is not the same person still standing there
?bodytracks=0         stop drawing the route walked inside the visit a body stands in
?bodytags=0           stop the name + hedge label over each body
?bodythrough=1        draw and pick bodies through the world (a whole-world finder; by default a
                      body obeys walls, because a person inside a house is inside it)
?bodypick=0           put nearest-wins back for a pixel: today a person answers a click before a
                      change marker does, and the floor under their feet never counts as occlusion
?bodywall=0           let any drawn layer hide a body, instead of only the real chunk voxels (a baked
                      LOD tile is approximated ground and cannot prove a person is out of sight)
?bodyseen=0           put the bare distance contest back for a person. By default the frame and the click
                      ask ONE question of the voxels this page holds - is anything solid between the eye
                      and this body? - sampled at head, chest and hip across the shoulders, because one ray
                      at the chest hides a person standing behind a half-wall. Whoever has a clear way in
                      draws with depth off and answers the click; whoever does not, hides. 3 of the 4 people
                      at the meadow party pass, 1 stands behind ground and hides (build/q_ghostseen.js)
?bodyskin=0           stop wearing the fetched skins: the cast goes back to band colours. The pack is
                      fetched ONCE by `tools/fetch-skins.mjs` and composed by the server into ONE strip
                      (a 64px cell per player, last cell solid white), so one texture dresses everybody
                      and a player with no skin stands on white rather than in a guess
?bodyovers=0          stop the model's second layer (hat, jacket, sleeves). It is alpha-tested, not
                      blended, which is also why the inside of a jacket is never drawn
?markdepth=0          stop a change marker writing depth, so the overlay paints in BUFFER/log order instead
                      of depth order. That was the default, and it is what "draw order is fucked up" was: a
                      claim farther from the eye won the pixel over a nearer one just by being written later
                      (62,564 of 1,024,000 pixels move when this is switched at one wall framing, while a
                      control pair with nothing switched moves 1). People survive the switch because they
                      now answer per body, not as a layer
?markside=0           draw both sides of every marker. The default shows the OUTSIDE only; "faces in the
                      back, again inverted" was this layer painting the inside of every logged wall through
                      its own outside. Crossed plants stay two-sided honestly - the geometry carries a
                      reversed-index twin (?timetwin=0 removes it), which costs indices and no corners
?markpick=0           let a change marker answer a pixel no matter what ground stands in front of it.
?markpick=2           the older rule: only REAL chunk ground may bury a marker, and a coarse surface counts
                      even where the LOD clip has discarded it. Measured over 50 sampled pixels per framing
                      (party 1/50 disagree, dense wall 1/50, mine 0/50) - better than counting every coarse
                      hit (1/50, 3/50, 7/50) and worse than the default below.
                      Default: a marker owns a pixel only when it is in front of the ground the frame actually
                      DRAWS there. A coarse far patch counts only where no chunk mesh owns that column, since
                      the clip shader throws its fragments away where real ground is installed: at the mine a
                      LOD surface 14.27 was nearer to the ray than a marker at 14.57 and the frame showed the
                      MARKER, while at the party a baked LOD plant at 16.22 over a marker at 16.23 really was
                      the picture, with no real ground nearer than 91. A dead-heat depth goes to the GROUND and
                      the answer says it was a tie: at the wall every sampled coplanar pixel showed the block's
                      own face. The change on that voxel is still one click away, through the per-voxel answer
                      table rather than a ray
?markalpha=0          let a marker answer even when its own sprite is transparent at the texel you aimed at.
                      A fern marker in front of a lawn answers the RAY and paints the lawn: the fragment
                      shader throws the texel away (alphaTest), and no distance rule can see that. The page
                      samples its own CPU copy of the atlas at the hit's uv to decide - exact at mip level 0,
                      and knowingly NOT a prediction of a mip-filtered sample far away, where the averaged
                      sprite can fall under the test (?mipmax=0 is the A/B, and it called those same pixels
                      unpainted MORE often, because a plant marker 100 blocks off paints whole in the picture).
                      The atlas is therefore filtered anisotropically so the ray's sample and the pixel's
                      sample sit in the same place
?markaniso=0          no anisotropic filtering of the atlas (it is otherwise capped by the device's own
                      maximum, so a low-end GL is not being asked for something it cannot do)
?timetwin=0           drop the reversed twin of authored model geometry: a plant marker then disappears when
                      seen from behind, since the layer culls back faces
?hover=0, ?timepick=0 (let the outline answer today's mesh again)
?follow=playerA       put the camera on one person, by name or 1-based index. It can only stand where the
                      EVIDENCE puts them: a body exists where that player's own hand changed a block, so
                      through a silence longer than ?bodygap the camera HOLDS and says so instead of
                      gliding somewhere the log never saw. Turning it on also filters the overlay, the
                      markers and the replay to that player
?followdist=40        how far the camera keeps itself from the person it follows (at whole-world zoom two
                      of one person's own actions sit 900 blocks apart, so following pulls the orbit in)
?followsnap=120       a gap bigger than this is a JUMP, not a pan: across a silence longer than the body
                      gap a hand moves a median 52-155 blocks and a p90 over 1,100 (build/dbg-gaps.mjs)
?nocov=1              stop using the region listing: ask for every tile again (the pan A/B)
?groundttl=120000     how long the page believes that listing, ms
?bar=0                no loading bar. It is off for every framebuffer A/B probe, because an animated
                      stripe is a moving pixel and would contaminate a diff
?debug=1              instrument panel and HUD
```

The full list is the first ~200 lines of `web/js/main.js`, and the collapsed groups carry
the knobs that are only interesting while measuring.

One honest hole in the replay: the atlas carries a shape only for a block that stands somewhere in the world
**today**, because the atlas is built from a census of the present chunks. 409 of this dimension's 90,045
place claims (0.45%) name a block the atlas has never seen — carried shulker boxes, a toilet, plushies, and
96 `minecraft:white_concrete_powder` in the very chunk whose wall looked wrong (the players later re-skinned
that wall light grey, so the blocks in the log no longer exist anywhere to be censused). Those claims still
count, still sit on the playhead and still answer a click; they draw no shape. `node build/dbg-unknownnames.mjs`
names every one of them, and the note carries the count.

A small pill in the lower-left corner says what the page is waiting for, and is only as confident as the
counters behind it: a **fraction** when every pending kind of work has a total (chunks held, mesh cuts owed,
replay chunks), a **stripe with counts** when some pending work has no known total (far-ground patches to
re-cut, the first action-log fetch), and **nothing at all** once the page settles - a counter nobody reported
for 1.5 s expires rather than freezing at a made-up percentage. `node build/q_bar.js` measures all three
states; `?bar=0` takes the pill out of the picture.

The panel also remembers what you moved, per browser (`localStorage`), and re-applies that at boot
whenever the URL names nothing - which is why a link with any parameter always shows what it
claims. Cost ceilings are deliberately left out of that memory: a ceiling is a measurement of this
data and this machine, and a remembered one outlives the measurement (a viewer holding the old 128
MB kept getting flat tiles after the replay was repriced as blocks). The panel button
**forget view** drops the whole snapshot and boots on what the page ships with.

---

## Tests and measurement

```bash
npm test                # 505 tests: formats, codecs, stores, mesher, lighting, collision, deployment contract,
                        # pool split, ledger, time machine (incl. what a pick may answer and what one
                        # voxel may draw), region coverage, remembered settings, the loading bar's
                        # promise, HTTP endpoints
npm run test:fast       # the logic layers, a few seconds
node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=102,119,49&dist=20&res=1&noautores&bar=0&ms=2600&ablod&ablodhide" \
    --wait 14000 --eval-file build/q_fps.js      # fps per state, with three's submitted call/triangle counts
node build/parse_fps.cjs <log>                   # the per-state table, machine-read
node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=102,119,49&dist=1200&res=1&noautores&bar=0&idle" \
    --wait 14000 --eval-file build/q_lodhidepix.js   # pixel A/B of the baked-tile skip, after the view settles
node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=-8,126,90&dist=25&time=1&timecls=0&res=1&noautores&bar=0&idle&tsec=1638&box=18&abovers" \
    --wait 20000 --eval-file build/q_skinpix.js  # skin vs tint, and jacket vs none, on the pixels each BODY covers
node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=-8,126,90&dist=10&time=1&timecls=0&res=1&noautores&bar=0&idle&tsec=1638" \
    --wait 18000 --eval-file build/q_skinuv.js   # the people mesh's own groups, materials, UV range, and the strip texels
node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=-8,126,90&dist=25&time=1&timecls=0&res=1&noautores&bar=0&gsec=1638&gat=-8,126,90" \
    --wait 16000 --eval-file build/q_m15shot.js --post 3000 --shot 700x460 --out build/shot_skins_party.png
node tools/mprobe.mjs --shot N url          # A/B two URLs by pixel band difference
```

Visual correctness here is proved numerically: framebuffer A/B, pixel-band diffs, and
`readPixels` probes in the same sRGB/linear space three.js uses. Screenshots are for
looking, not for deciding. `HANDOFF.md` "Gotchas" is the list of traps already paid for
(atlas UV is top-down, GL rows are bottom-origin, index buffers are `geometry.index` and
not an attribute, empty batch frames are meaningful, byte figures must name their kind).

---

## Open work

`PLAN.md` holds the milestone table; `HANDOFF.md` §6 holds what is actually next.

* **M7** modded correctness pass (multipart fences/walls/panes/rails, translucent
  sorting, water/glass edges, tints). Parked until it shows a visible problem.
* **M8** modded asset coverage / fallback. Parked pending a stated purpose.
* **M9** portability: `--world` end to end, per-save cache and pack tags, a second save as
  a CI fixture. Started; `tools/portcheck.mjs` reports the hard requirements.
* **M12b** per-voxel block history: which blocks a chosen player placed, filtered in time.
* **M15.4** the people layer's remaining half: player chips, a per-player coordinate history
  *panel* (the body card already lists their nearby actions; the panel does not), skins from an
  operator-supplied `web/skins/<name>.png`, and mob ghosts (36,661 `trample` rows are positional
  but name nobody). What M15 already ships: timeline v4 `source`, `shared/ghosts.mjs`, and bodies /
  routes / name tags / evidence cards in the page.
* Performance is at: whole-world orbit 240–400 fps settled, a 60-centre pan settles in
  3.1 s, far grid re-cut is 100 % on worker threads, unwritten ground costs 1 ms instead
  of 23,000. The far bill is now dominated by coarse patch re-cut, not the server.
