#!/usr/bin/env node
/**
 * Player skins, into `build/skins`, for the people standing in the map.
 *
 *   node tools/fetch-skins.mjs [--world DarkRPG/world] [--out build/skins]
 *                              [--ledger build/ledger] [--offline] [--force]
 *
 * Why the roundabout way: the page knows players by NAME (the ledger names them) and the save knows
 * them by UUID (`world/playerdata/<uuid>.dat`). A skin is reachable only from a UUID, and only through
 * Mojang: sessionserver hands back a base64 "properties" blob whose `SKIN.url` is a texture on
 * textures.minecraft.net. So this tool joins the three and writes something the server can serve
 * without any network at run time:
 *
 *   build/skins/manifest.json      uuid, name, model (classic|slim), texture file, provenance
 *   build/skins/textures/<hash>.png
 *
 * What is NOT invented here: a UUID that sessionserver does not recognise gets `noProfile: true` and
 * no texture. An offline-mode (cracked) server produces exactly that, and the browser then draws its
 * plain tinted body rather than guessing a skin for a person it cannot name. The names in the ledger
 * and the UUIDs in playerdata are cross-checked rather than assumed to agree - when a name resolves to
 * a UUID that is not in playerdata, both are still recorded, because the ledger is the thing the page
 * asks about.
 *
 * Rate limits are real: api.mojang.com answered 429 with an HTML error page partway through six
 * lookups. So lookups run sequentially, wait between them, honour `Retry-After`, back off, and above
 * all CACHE: an entry already in the manifest with a texture on disk is not re-asked unless --force.
 * Re-running this tool should cost one HTTP request per new player, not six.
 *
 * Offline fallback: a Minecraft client on this machine keeps its own skin cache at
 * `<.minecraft>/assets/skins/<hash[0..2]>/<hash>`, named by the same hash the texture URL carries. If
 * the CDN is unreachable but the client already fetched that skin, the copy is used and recorded as
 * `from: "client-cache"`. That is a copy of a file this machine already has, not a second download.
 *
 * Skins are player-uploaded content, not part of this repo: `build/` is git-ignored, so nothing here is
 * committed. A deployment either runs this tool where it has network, or copies `build/skins/` over.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = path.resolve(arg('world', path.join(ROOT, 'DarkRPG/world')));
const LEDGER = path.resolve(arg('ledger', path.join(ROOT, 'build/ledger')));
const OUT = path.resolve(arg('out', path.join(ROOT, 'build/skins')));
const CLIENT_CACHE = arg('client-cache',
  process.env.APPDATA
    ? path.join(process.env.APPDATA, '.minecraft', 'assets', 'skins')
    : path.join(process.env.HOME || '', '.minecraft', 'assets', 'skins'));
const OFFLINE = process.argv.includes('--offline');
const FORCE = process.argv.includes('--force');

const MOJANG_PROFILE = 'https://api.mojang.com/users/profiles/minecraft/';
const SESSION_PROFILE = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const GAP_MS = 900;                 // api.mojang.com: measured 429 at well under ten quick lookups
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (m) => console.log(m);
const dashed = (id) => (id.length === 32 && !id.includes('-')
  ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id);

/** Who the save itself knows about: the UUIDs of the .dat files it wrote for each player. */
function playerdataUuids(worldDir) {
  const dir = path.join(worldDir, 'playerdata');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.dat'))
    .map((f) => dashed(f.slice(0, -4).toLowerCase())).sort();
}

/** Who the action log names: the ledger's own player list. */
function ledgerNames(ledgerDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'meta.json'), 'utf8'));
    const out = new Map();
    for (const p of meta.players || []) {
      // The ledger records names; some exports also carry a uuid. Either is useful, both are kept.
      const nm = typeof p === 'string' ? p : (p.name || p.player);
      const id = typeof p === 'object' && p.uuid ? dashed(String(p.uuid).replace(/-/g, '')) : null;
      if (nm) out.set(nm, id);
    }
    return out;
  } catch { return new Map(); }
}

async function getJson(url, { tries = 4 } = {}) {
  for (let t = 0; t < tries; t++) {
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
    catch (e) { log(`  ${url.replace(/^https:\/\//, '')} -> ${e.name}`); }
    if (r) {
      if (r.status === 204) return { status: 204, json: null };
      if (r.ok) return { status: r.status, json: await r.json().catch(() => null) };
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after') || 0);
        const back = Math.max(2000, ra * 1000) * (t + 1);
        log(`  rate limited (429), waiting ${Math.round(back / 1000)} s`);
        await wait(back);
        continue;
      }
      if (r.status === 404) return { status: 404, json: null };
      log(`  ${url.replace(/^https:\/\//, '')} -> ${r.status}`);
    }
    if (t + 1 < tries) await wait(1500 * (t + 1));
  }
  return { status: 0, json: null };
}

/** The client's own skin cache, if this machine has one: named by the same hash as the texture URL. */
function clientCacheCopy(hash, dest) {
  if (!CLIENT_CACHE || !fs.existsSync(CLIENT_CACHE)) return false;
  const cand = [path.join(CLIENT_CACHE, hash.slice(0, 2), hash), path.join(CLIENT_CACHE, hash)];
  for (const src of cand) {
    if (!fs.existsSync(src)) continue;
    try {
      const b = fs.readFileSync(src);
      if (!isPng(b)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, b);
      return true;
    } catch { /* unreadable: not a fallback */ }
  }
  return false;
}

const isPng = (b) => b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

async function main() {
  const uuids = playerdataUuids(WORLD);
  const names = ledgerNames(LEDGER);
  log(`save ${WORLD}`);
  log(`  playerdata uuids ${uuids.length}: ${uuids.join(' ') || '(none)'}`);
  log(`  ledger names     ${names.size}: ${[...names.keys()].join(', ') || '(none)'}`);
  if (!uuids.length && !names.size) {
    console.error('nothing to fetch: no playerdata in the save and no players in the ledger');
    process.exit(1);
  }

  const manifestPath = path.join(OUT, 'manifest.json');
  const prev = (() => { try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { skins: [] }; } })();
  const byUuid = new Map((prev.skins || []).map((s) => [s.uuid, s]));
  const have = (s) => s && s.texture && fs.existsSync(path.join(OUT, s.texture));

  // UUIDs the save knows, with any ledger name that resolves to the same id.
  const nameById = new Map();
  for (const [nm, id] of names) if (id) nameById.set(id, nm);
  // Names the ledger has but the save's playerdata does not: resolve them, because the page asks by name.
  const unresolved = [...names.entries()].filter(([nm, id]) => !id || !uuids.includes(id));

  const report = { kept: 0, fetched: 0, cached: 0, noProfile: 0, failed: 0 };

  for (const uuid of uuids) {
    const old = byUuid.get(uuid);
    if (!FORCE && have(old)) { byUuid.set(uuid, old); report.kept++; continue; }
    if (OFFLINE) {
      // Without network the only honest move is: keep whatever is already on disk, and say nothing else.
      if (have(old)) { report.kept++; } else { byUuid.delete(uuid); }
      continue;
    }
    await wait(GAP_MS);
    const p = await getJson(SESSION_PROFILE + uuid);
    if (p.status === 204 || p.status === 404) {
      const e = { uuid, name: nameById.get(uuid) || old?.name || null, noProfile: true, texture: null };
      byUuid.set(uuid, e); report.noProfile++; continue;
    }
    if (!p.json?.properties?.[0]?.value) {
      const e = { uuid, name: nameById.get(uuid) || old?.name || null, lookupFailed: true, texture: null };
      byUuid.set(uuid, e); report.failed++; continue;
    }
    let blob;
    try { blob = JSON.parse(Buffer.from(p.json.properties[0].value, 'base64').toString('utf8')); }
    catch { blob = null; }
    const skin = blob?.textures?.SKIN;
    if (!skin?.url) {
      const e = { uuid, name: p.json.name || nameById.get(uuid) || null, noSkin: true, texture: null };
      byUuid.set(uuid, e); report.noProfile++; continue;
    }
    const hash = skin.url.split('/').pop();
    const file = `textures/${hash}.png`;   // forward slashes: this string becomes a URL on the page
    const dest = path.join(OUT, file);
    let from = 'disk';
    if (!fs.existsSync(dest) || FORCE) {
      from = 'cdn';
      if (!OFFLINE) {
        const r = await fetch(skin.url, { signal: AbortSignal.timeout(20000) }).catch(() => null);
        const buf = r && r.ok ? Buffer.from(await r.arrayBuffer()) : null;
        if (!buf || !isPng(buf)) {
          from = 'client-cache';
          if (!clientCacheCopy(hash, dest)) {
            const e = { uuid, name: p.json.name, hash, slim: skin.metadata?.model === 'slim',
              url: skin.url, texture: old?.texture || null, downloadFailed: true };
            byUuid.set(uuid, e); report.failed++; continue;
          }
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
        }
      } else if (!clientCacheCopy(hash, dest)) {
        from = 'unavailable';
      }
    }
    const st = (() => { try { return pngSize(fs.readFileSync(dest)); } catch { return null; } })();
    byUuid.set(uuid, {
      uuid, name: p.json.name || nameById.get(uuid) || old?.name || null,
      slim: skin.metadata?.model === 'slim', hash, texture: file,
      size: st ? [st.w, st.h] : null, from, fetched: new Date().toISOString(),
    });
    if (from === 'client-cache') report.cached++; else report.fetched++;
    if (from === 'unavailable') report.failed++;
  }

  // Names with no playerdata entry: still worth a texture, keyed by the UUID Mojang gives back, plus
  // an alias so the page can look them up by name. A name Mojang does not know (renamed account, or a
  // name an offline-mode server made up) is RECORDED as noProfile rather than skipped: the page then
  // says "this one has no skin" instead of leaving a hole in the manifest for whoever reads it.
  for (const [nm, id] of unresolved) {
    if (OFFLINE) continue;
    await wait(GAP_MS);
    const p = await getJson(MOJANG_PROFILE + encodeURIComponent(nm));
    if (!p.json?.id) {
      byUuid.set(id || `name:${nm}`, {
        uuid: id || null, name: nm, noProfile: true, texture: null,
        note: 'no Mojang profile for this name',
      });
      report.noProfile++;
      continue;
    }
    const uuid = dashed(p.json.id);
    if (byUuid.has(uuid) && have(byUuid.get(uuid))) {
      const e = byUuid.get(uuid); e.name = e.name || p.json.name; byUuid.set(uuid, e); continue;
    }
    const r = await fetch(SESSION_PROFILE + uuid, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r?.ok) continue;
    const j = await r.json().catch(() => null);
    let blob = null;
    try { blob = JSON.parse(Buffer.from(j.properties[0].value, 'base64').toString('utf8')); } catch { /* no skin */ }
    const skin = blob?.textures?.SKIN;
    if (!skin?.url) continue;
    const hash = skin.url.split('/').pop();
    const file = `textures/${hash}.png`;   // forward slashes: this string becomes a URL on the page
    const dest = path.join(OUT, file);
    if (!fs.existsSync(dest)) {
      const t = await fetch(skin.url, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      const buf = t && t.ok ? Buffer.from(await t.arrayBuffer()) : null;
      if (!buf || !isPng(buf)) { if (!clientCacheCopy(hash, dest)) { report.failed++; continue; } }
      else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
    }
    const st = pngSize(fs.readFileSync(dest));
    byUuid.set(uuid, { uuid, name: p.json.name, slim: skin.metadata?.model === 'slim', hash,
      texture: file, size: [st.w, st.h], from: 'cdn', fetched: new Date().toISOString() });
    report.fetched++;
  }

  const skins = [...byUuid.values()]
    .map((s) => (s.name ? s : { ...s, name: null }))
    .sort((a, b) => (a.name || a.uuid).localeCompare(b.name || b.uuid));
  const manifest = {
    generated: new Date().toISOString(),
    world: path.basename(path.dirname(WORLD)) + '/' + path.basename(WORLD),
    source: OFFLINE ? 'cache-only' : 'mojang',
    skins,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = manifestPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 1));
  fs.renameSync(tmp, manifestPath);

  log(`\n${OUT}/manifest.json`);
  for (const s of skins) {
    log(`  ${(s.name || '(unnamed)').padEnd(16)} ${s.uuid}  ${s.slim ? 'slim  ' : 'classic'}  ` +
      `${s.texture ? `${s.texture}${s.size ? ` ${s.size.join('x')}` : ''} (${s.from})` : s.noProfile ? 'no Mojang profile' : s.downloadFailed ? 'download failed' : '-'}`);
  }
  log(`kept ${report.kept}, fetched ${report.fetched}, from client cache ${report.cached}, ` +
    `no profile ${report.noProfile}, failed ${report.failed}`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
