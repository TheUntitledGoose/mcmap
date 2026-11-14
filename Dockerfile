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
# If the machine building the image does not have the packs (a plain clone of this repo never does),
# the build still works and the packs come from read-only mounts instead:
#   -v /srv/mcmap/packs/assets:/srv/app/build/assets:ro   (and shells, lods, ledger the same way)
# Mounting at those paths needs no configuration, because they are the paths the server reads by default.
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
#
# Each of these directories is tracked by a `.keep` file, so this COPY also works on a machine that has
# never baked anything: the directory exists, holds only the keep file, and the report below says so.
# That is not a shortcut around the packs — it is what lets a stack deployed from a clone of this repo
# reach the answer instead of dying in COPY with "failed to compute cache key: /build/ledger: not found",
# which names no file, no cause and no fix. Either bake them here, or mount them at run time (the paths
# below are exactly the paths the server reads by default, so a mount needs no WD_* change).
COPY build/assets/ ./build/assets/
COPY build/shells/ ./build/shells/
COPY build/lods/ ./build/lods/
COPY build/ledger/ ./build/ledger/
# Player skins, if this build machine fetched them (tools/fetch-skins.mjs writes build/skins/). Optional in
# a way the packs above are not: with no manifest the server says so on /meta and the cast stands in its
# own band colours. The directory is tracked by an empty keep file so this COPY never fails on a clone.
COPY build/skins/ ./build/skins/

# Preflight: report, do not fail. The packs are derived data and git-ignored, so the honest question is
# not "did the build machine have them" but "will this container be told where they are". Failing the
# build here made the clone case impossible instead of merely incomplete; worldd still refuses to start
# without the asset pack (and says which variable to mount), so nothing broken pretends to work.
RUN node -e "const fs=require('fs');const P=[['assets','build/assets',['atlas.json','geometry.bin','atlas.png'],'WD_ASSETS'],['shells','build/shells',[],'WD_PACKS'],['lods','build/lods',[],'WD_LODS'],['ledger','build/ledger',[],'WD_LEDGER']];let miss=0;for(const [n,p,need,env] of P){const files=fs.existsSync(p)?fs.readdirSync(p).filter(f=>f!=='.keep'):[];const ok=need.length?need.every(f=>fs.existsSync(p+'/'+f)):files.length>0;if(ok){console.log('pack '+n+': '+p+' ('+files.length+' entries)')}else{miss++;console.log('pack '+n+': NOT HERE - '+p+' holds only the keep file -> mount a baked pack there, or bake it here and rebuild')}}if(!miss){console.log('all packs are in the image')}else{console.log('  bake on a machine holding the save and your own 1.20.1 jar:  npm run bake && npm run bake:ledger');console.log('  or mount one read-only at the path worldd already reads:  -v /srv/mcmap/packs/assets:/srv/app/build/assets:ro');console.log('  the asset pack is required: worldd exits at boot and names the same paths')}"
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
