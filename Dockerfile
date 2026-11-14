# The renderer's serving side, as one image.
#
# What this container is: the same `worldd` you run on the desktop. It reads chunk payloads live out
# of the world save (the one thing it cannot precompute) and serves everything else from baked packs
# built on a machine that has the save and the game jars.
#
#   docker build -t mcmap .
#   docker run -d --name mcmap -p 8765:8765 \
#     -v /path/to/DarkRPG:/data/DarkRPG:ro -v mcmap-cache:/data/cache mcmap
#
# The save is a mount, not a layer: a multi-gigabyte living directory whose copies inside an image
# silently go stale. The packs are layers: derived, versioned with the code, and an hour to re-bake,
# so shipping them with the image is what makes a fresh container useful in seconds. Rebuild the
# image when the packs or the source change; the cache is the only thing that may live in the
# container's own filesystem.
#
# Build context note: .dockerignore keeps the ~3.6 GB save and the multi-GB payload cache out of the
# context. Without it, `docker build` uploads gigabytes before doing anything and looks broken.

FROM node:22-alpine

# `worldd` is Node built-ins only (fs/http/zlib/path/os). No build toolchain, no native modules, and
# the health check uses node's own fetch rather than a package, so the runtime stays this layer.
WORKDIR /srv/app

# Dependencies first, so editing web/js does not re-resolve the tree. Only three + ws are needed at
# runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The serving code. `tools/` comes along because worldd imports tools/nbt.mjs, and because checking a
# pack build inside the image is a thing you sometimes want to do.
COPY server/ ./server/
COPY shared/ ./shared/
COPY tools/ ./tools/
COPY web/ ./web/

# Derived packs: everything a browser asks for besides /voxels. build/cache is deliberately absent —
# it is regenerated per container. build/ledger/actions.bin is excluded by .dockerignore (the page
# reads the .ledpack files; the raw 32 MB action dump is for analysis tools).
COPY build/assets/ ./build/assets/
COPY build/shells/ ./build/shells/
COPY build/lods/ ./build/lods/
COPY build/ledger/ ./build/ledger/
# Player skins, if this build machine fetched them (tools/fetch-skins.mjs writes build/skins/). Optional in
# a way the packs above are not: with no manifest the server says so on /meta and the cast stands in its
# own band colours. The directory is tracked by an empty keep file so this COPY never fails on a clone.
COPY build/skins/ ./build/skins/

# Preflight, with the sentence that tells you what to do rather than a stack of missing paths. The
# packs are derived data and git-ignored: a clone of this repo has no build/assets at all, and a
# container that starts without them serves a world with holes where the far layers should be.
RUN node -e "const fs=require('fs');const need=['build/assets/atlas.json','build/assets/geometry.bin','build/assets/atlas.png'];const miss=need.filter(f=>!fs.existsSync(f));if(miss.length){console.error('image is missing '+miss.join(', '));console.error('the packs are derived, not committed: run \'npm run bake\' (and \'npm run bake:ledger\' for the history) on a machine holding the save and the game jars, then build again');process.exit(1)}" \
 && node -e "const fs=require('fs');const d=['build/shells','build/lods','build/ledger'];for(const p of d){if(!fs.existsSync(p)){console.error('missing '+p+': bake it before building the image');process.exit(1)}const n=fs.readdirSync(p).filter(f=>fs.statSync(p+'/'+f).isFile()).length;if(!n){console.error(p+' is empty: bake it before building the image');process.exit(1)}console.log('pack '+p+': '+n+' files')}"
# The skin pack is the one derived input that may legitimately be absent, so this reports instead of failing.
RUN node -e "const fs=require('fs');const f='build/skins/manifest.json';const n=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')).skins.length:0;console.log(n?('pack build/skins: '+n+' players'):('pack build/skins: none (optional: the cast stands tinted; tools/fetch-skins.mjs fetches the pack once)'))"

# The save is the one thing that must be told to the container. Everything else has a path inside
# the image. WD_* variables are translated to worldd's own flags (shared/envargs.mjs): they show up
# in Portainer's environment table, where a baked-in command line does not.
ENV WD_WORLD=/data/DarkRPG/world \
    WD_CACHE=/data/cache \
    WD_SKINS=/srv/app/build/skins \
    WD_CACHE_MAX_GB=6 \
    WD_HOST=0.0.0.0 \
    WD_PORT=8765

# Writable scratch for the payload cache, owned by the uid that will run.
RUN mkdir -p /data/cache && chown -R node:node /data

VOLUME ["/data/cache"]
EXPOSE 8765

USER node

# A container that boots, cannot find atlas.json and exits 1 has already said why in the log. This
# keeps it honest afterwards: /stats is the cheapest route that proves the service loop is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WD_PORT||8765)+'/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/worldd.mjs"]
