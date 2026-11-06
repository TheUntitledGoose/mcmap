// Indexes blockstates/models/textures across the vanilla client jar + all mod jars.
// First registered jar wins a path (vanilla loaded last => mods may override).
import fs from 'node:fs';
import path from 'node:path';
import { ZipFile } from './zip.mjs';

const KIND_BY_DIR = { blockstates: 'json', models: 'json', textures: 'png' };

export const DEFAULT_VANILLA_JAR = 'your .minecraft/versions/1.20.1/1.20.1.jar';

// Jar order is asset-pack order: earlier jars win, so mods may override vanilla assets exactly as
// they do in Minecraft. The vanilla jar is always included (and always last) — a renderer without
// vanilla blockstates would bake the whole world to air.
export function defaultJars(serverRoot, vanillaJar = DEFAULT_VANILLA_JAR) {
  const jars = [];
  const modDir = path.join(serverRoot, 'mods');
  if (fs.existsSync(modDir)) {
    for (const f of fs.readdirSync(modDir).sort()) {
      if (!f.toLowerCase().endsWith('.jar')) continue;
      jars.push(path.join(modDir, f));
    }
  }
  if (fs.existsSync(vanillaJar)) jars.push(vanillaJar);
  return jars;
}

export class AssetIndex {
  #pathCache = new Map();

  constructor(jarPaths) {
    this.jarPaths = jarPaths;
    this.jars = [];
    this.map = new Map(); // asset path -> [jarIdx, entryName]
    this.stats = { jars: 0, skipped: 0, blockstates: 0, models: 0, textures: 0 };
    // Later jars are only consulted for paths no earlier jar provided.
    for (let ji = jarPaths.length - 1; ji >= 0; ji--) this.#ingest(jarPaths[ji], ji);
    this.jars = []; // free handles; entries are read on demand
  }

  // A momentary share violation on Windows (EPERM / EBUSY) is not a missing jar: an antivirus scan or
  // a sibling test process can hold it for a tenth of a second. Retry that, and only that, a few
  // times. Anything else - a truncated jar, a wrong path - fails at once.
  #openJar(p) {
    let last;
    for (let try_ = 0; try_ < 5; try_++) {
      try { return new ZipFile(p); }
      catch (e) {
        last = e;
        if (e && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (try_ + 1));
      }
    }
    throw last;
  }

  #ingest(p, jarIdx) {
    let z;
    try { z = this.#openJar(p); }
    catch (e) {
      // A jar that will not open is not "some optional mod we can do without": it is one the caller
      // listed deliberately, and skipping it silently drops every model it provided. The census then
      // has states with no geometry and the renderer draws them as nothing - no error anywhere. This
      // showed up as a full-suite-only coverage failure (88%, then 91%) while the identical pack run
      // on its own measured 100%: the jar was momentarily locked by a sibling process. A build that
      // quietly loses a jar is worse than a build that stops and names it.
      throw new Error(`asset index cannot open jar ${p}: ${e.message}`);
    }
    this.stats.jars++;
    for (const name of z.names()) {
      if (!name.startsWith('assets/')) continue;
      const rest = name.slice('assets/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const ns = rest.slice(0, slash);
      const sub = rest.slice(slash + 1);
      const dir = sub.slice(0, sub.indexOf('/'));
      if (!(dir in KIND_BY_DIR)) continue;
      const file = sub.slice(sub.indexOf('/') + 1);
      if (dir === 'textures') {
        if (!file.endsWith('.png')) continue;
        this.stats.textures++;
      } else {
        if (!file.endsWith('.json')) continue;
        this.stats[dir]++;
      }
      this.map.set(`${ns}:${dir}/${file}`, [jarIdx, name]);
    }
    this.jars[jarIdx] = z;
  }

  #open(jarIdx) {
    if (!this.jars[jarIdx]) this.jars[jarIdx] = new ZipFile(this.jarPaths[jarIdx]);
    return this.jars[jarIdx];
  }

  split(id, kind, ext) {
    const i = id.indexOf(':');
    const ns = i < 0 ? 'minecraft' : id.slice(0, i);
    const pathPart = i < 0 ? id : id.slice(i + 1);
    return `${ns}:${kind}/${pathPart}${ext}`;
  }

  has(id, kind, ext) { return this.map.has(this.split(id, kind, ext)); }

  /**
   * Nearest existing sibling of a missing asset: same namespace and kind, name starting with the
   * missing name plus a '_' or '/' separator, shortest name wins. Mods occasionally reference a
   * model they never ship (lootr's barrel models are generated at runtime); a close sibling renders
   * far better than nothing. Callers should log the substitution.
   */
  sibling(id, kind) {
    const i = id.indexOf(':');
    const ns = i < 0 ? 'minecraft' : id.slice(0, i);
    const pathPart = i < 0 ? id : id.slice(i + 1);
    const ids = this.#paths(ns, kind);
    let best = null;
    for (const p of ids) {
      if (p.length <= pathPart.length || !p.startsWith(pathPart)) continue;
      const sep = p[pathPart.length];
      if (sep !== '_' && sep !== '/') continue;
      if (!best || p.length < best.length) best = p;
    }
    return best === null ? null : `${ns}:${best}`;
  }

  #paths(ns, kind) {
    const ck = `${ns}:${kind}/`;
    let list = this.#pathCache.get(ck);
    if (!list) {
      list = [];
      for (const key of this.map.keys()) if (key.startsWith(ck)) list.push(key.slice(ck.length).replace(/\.json$|\.png$/, ''));
      this.#pathCache.set(ck, list);
    }
    return list;
  }

  readJson(id, kind) {
    const e = this.map.get(this.split(id, kind, '.json'));
    if (!e) return null;
    const txt = this.#open(e[0]).readText(e[1]);
    if (txt == null) return null;
    try { return JSON.parse(txt); }
    catch (err) { this.badJson = (this.badJson ?? new Set()).add(e[1]); return null; }
  }

  readPng(id) {
    const e = this.map.get(this.split(id, 'textures', '.png'));
    return e ? this.#open(e[0]).read(e[1]) : null;
  }

  close() { for (const z of this.jars) z?.close(); this.jars = []; }
}
