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
`H` instruments, `?` help, `T` ask about the block under the crosshair, click a block in
orbit mode for its block history card. With the time machine on, a stand-in figure stands
where each player's hand acted: click the figure, or the name tag over it, for what the log
actually says about that person (the tag is the part that stays reachable when rock is in
front of them, and "only this player's edits" is a button inside that card, not a click away).

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
?res=1.5              draw resolution (supersampling above 1)
?ledger=1             block-history overlay; ?ledgerwho=, ?ledgercls=, ?ledgermin=
?time=1               the time machine; ?timecls=2 (kind), ?timeplay=0 (paused),
                      ?timelook=blocks|plates|tiles, ?timegeommb=384 (the ceiling a block-shaped
                      replay may reach; 336 MB is what this dimension's any-change filter costs as
                      blocks, and below that it steps down to flat plates), ?timegrow=0 (put the
                      markers flush with their voxel), ?timetiles=0,
                      ?timeterrain=0 (undo the log in the voxels), ?timesharp=12 (replay in a wider
                      square than the view draws sharp), ?timestack=0 (older claims at one voxel stop
                      owning it), ?timecull=0 (draw the faces that sit inside the players' own build,
                      which is what made a wall of placed blocks read as inverted normals),
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
?markdepth=1          make a change marker write depth again: by default it tests the world's depth but
                      never writes its own, because a marker that writes it seals the body standing in
                      the voxel the marker annotates
?nocov=1              stop using the region listing: ask for every tile again (the pan A/B)
?groundttl=120000     how long the page believes that listing, ms
?debug=1              instrument panel and HUD
```

The full list is the first ~200 lines of `web/js/main.js`, and the collapsed groups carry
the knobs that are only interesting while measuring.

The panel also remembers what you moved, per browser (`localStorage`), and re-applies that at boot
whenever the URL names nothing - which is why a link with any parameter always shows what it
claims. Cost ceilings are deliberately left out of that memory: a ceiling is a measurement of this
data and this machine, and a remembered one outlives the measurement (a viewer holding the old 128
MB kept getting flat tiles after the replay was repriced as blocks). The panel button
**forget view** drops the whole snapshot and boots on what the page ships with.

---

## Tests and measurement

```bash
npm test                # 441 tests: formats, codecs, stores, mesher, lighting, collision,
                        # pool split, ledger, time machine (incl. what a pick may answer), region
                        # coverage, remembered settings, HTTP endpoints
npm run test:fast       # the logic layers, a few seconds
npm run browser:probe   # headless Chromium against a live server: eval, framebuffer, shot
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
