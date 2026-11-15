/**
 * Adopt a payload-cache tree that belongs to this save under a different NAME.
 *
 * The cache identity is `<name>.<hash(canonical save directory, seed)>`. The hash half is what makes
 * this safe: it comes from the directory `realpath` resolved plus the `level.dat` seed, so nothing an
 * operator types contributes to it, and two directories with the same hash suffix are the same save on
 * this machine. The name half is display, and it legitimately changes: the same save opened as
 * `--world DarkRPG/world` and opened through a `--worlds` root as `darkrpg` is spelled
 * `darkrpg-world.<H>` and `darkrpg.<H>`.
 *
 * That mismatch is not cosmetic. It is 627 579 decoded chunks (2.3 GB, a full afternoon of CPU) sitting
 * in the directory nobody asks for while the live world decodes from scratch, and the sweep calls the
 * old tree "a save this server does not serve" and deletes it. Measured, and the reason this file
 * exists: the same 8x8 view went from 510 decodes to 510 cache hits once the tree was moved.
 *
 * So the server renames the tree at open, before it serves anything, and says so in one line. If the
 * live name already has payloads, the two trees are merged file by file with the newer payload winning
 * (`server/cache-move.mjs`). A tree that another world on this box claims is left alone: the keep-list
 * is the answer to "who owns this", and stealing a live world's cache would be worse than a re-decode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bins, mergeCacheTree } from './cache-move.mjs';

const LIGHTS = new Set(['lit', 'nolight']);

/**
 * Is this a payload tree at the SAVE level? A save directory holds state-table directories, and the light
 * generation sits one level under those - which is exactly how it differs from the pre-world layout
 * (`<state table>/<lit|nolight>/...` at the top), whose payloads cannot say which save they came from.
 */
function hasPayloadTree(dir) {
  let ent;
  try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ent) {
    if (!e.isDirectory()) continue;
    let sub;
    try { sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }); } catch { continue; }
    if (sub.some((s) => s.isDirectory() && LIGHTS.has(s.name))) return true;
  }
  return false;
}

/** The hash half of a tag: everything after the last dot. */
export function tagHashOf(tag) {
  const s = String(tag ?? '');
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i + 1);
}

/**
 * Rename (or merge) every unclaimed tree in `cacheDir` whose hash suffix equals `worldTag`'s.
 * Returns `{ adopted: [{ from, to, payloads, merged }], stat }`, and `adopted` is empty when there was
 * nothing to do - which is the normal boot.
 */
export function adoptCacheTag({ cacheDir = '', worldTag = '', keep = [], dry = false, log = () => {} } = {}) {
  const out = { adopted: [], stat: { moved: 0, clashed: 0, newerKept: 0, failed: 0, whole: 0 } };
  const hash = tagHashOf(worldTag);
  if (!cacheDir || !hash || !fs.existsSync(cacheDir)) return out;
  const claimed = new Set([String(worldTag), ...keep.map(String)]);
  const dest = path.join(cacheDir, worldTag);
  for (const e of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === worldTag) continue;
    if (!e.name.endsWith(`.${hash}`)) continue;          // a different save, or this one under another name
    const from = path.join(cacheDir, e.name);
    if (!hasPayloadTree(from)) continue;                 // not a payload tree at this level
    if (claimed.has(e.name)) continue;                   // a world on this box says it owns this one
    const exists = fs.existsSync(dest);
    // The payload count is only worth a walk of the tree when something is actually being moved: on a
    // normal boot this loop finds no candidate and must not touch 600 000 files to say so.
    if (!exists) {
      if (!dry) {
        try { fs.renameSync(from, dest); } catch (err) {
          log(`could not adopt ${e.name}: ${err.message}`
            + ` - if that is a cross-device rename, move it by hand:`
            + ` node tools/cache-retag.mjs --dir ${cacheDir} --from ${e.name} --to ${worldTag} --merge`);
          out.stat.failed++;
          continue;
        }
      }
      const n = bins(dry ? from : dest).length;
      out.adopted.push({ from: e.name, to: worldTag, payloads: n, merged: false });
      log(`${dry ? 'would move' : 'moved'} ${n} payloads: ${e.name} is this save under another name,`
        + ` and this world reads ${worldTag}`);
      continue;
    }
    // Both names hold payloads. Same save, same table: merge, newer payload wins.
    const n = bins(from).length;
    mergeCacheTree(from, dest, dry, out.stat);
    out.adopted.push({ from: e.name, to: worldTag, payloads: n, merged: true });
    log(`${dry ? 'would merge' : 'merged'} ${n} payloads from ${e.name} into ${worldTag}`
      + ` (both names hold this save's chunks)`);
  }
  return out;
}
