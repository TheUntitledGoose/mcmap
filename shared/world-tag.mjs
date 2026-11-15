/**
 * Which SAVE a cached chunk belongs to.
 *
 * The payload cache is saved CPU, not data. Its key already says which state-id table the payload was
 * encoded against (`tableTag`) and which payload generation it is (`lightTag`). What it never said was
 * which save - and two saves with the same mods share a state table, both call their biggest dimension
 * folder `region`, and a payload from one is a perfectly plausible-looking answer for the other: right
 * magic, right frame, right length, someone else's mountain. Nothing would complain. The map would just
 * be quietly wrong, and only for the world that was not served first.
 *
 * So the key gains a world level, and the question is what names it. The three candidates, and why this
 * one:
 *
 * - a digest of the region files: distinguishes saves sharply, but it moves every time a chunk is saved,
 *   which would orphan a whole cache because someone placed twelve blocks. The cache is CPU; that is a
 *   25-minute bill for a sneeze.
 * - the seed alone: stable, but two saves copied from the same seed (a staging copy, a second
 *   deployment) would share a cache while diverging from the first moment someone builds.
 * - the directory plus the seed: stable across a lifetime of play, distinct for every save anyone is
 *   likely to run side by side, and it changes exactly when the save at that path has been *replaced* by
 *   a different one - which is precisely when yesterday's payloads must not be read.
 *
 * Per-chunk staleness is a separate, already-solved question: `#cachePath` readers compare the payload's
 * mtime with its region file's, so a restored or edited region re-decodes its own chunks. This level is
 * only about which save the file was decoded from.
 *
 * Kept fs-free and browser-free-able: `shared/` is served to the page, so nothing here touches the disk.
 * The caller supplies the resolved world directory and (optionally) the seed from `level.dat`.
 */

/** Anything that cannot survive as a directory name. */
const NOT_NAME = /[^a-z0-9._-]+/g;

/**
 * A legible prefix: the last two path segments, lowercased and joined, `DarkRPG/world` -> `darkrpg-world`.
 * The tail is kept when it has to be cut, because the tail is the specific part: cutting the front of
 * `/srv/mcmap/worlds/darkrpg/save` keeps `darkrpg-save`, cutting the back keeps `mcmap-worlds`.
 */
function dirLabel(dir) {
  const parts = String(dir ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  const label = parts.slice(-2)
    .map((p) => p.toLowerCase().replace(NOT_NAME, '').replace(/^[._-]+|[._-]+$/g, ''))
    .filter(Boolean).join('-');
  return label.slice(-48) || 'world';
}

/** FNV-1a, 32 bits, as 8 hex digits. Not crypto: a name that is stable and retypeable. */
export function tagHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The tag for one save: <name>.<hash>.
 *
 * The NAME is what the operator asked for - --world-tag, or in the --worlds layout the folder the save
 * sits in - sanitized rather than trusted, because with M18's world dropdown a person names the world
 * and the cache directory should carry that name. It is display. It does not decide identity.
 *
 * The HASH is the save and nothing else: the directory it lives in, resolved, and its seed. One save
 * reached through a junction, a bind or a .. is therefore one cache, and `darkrpg-world.<H>` beside
 * `darkrpg.<H>` are provably one save - which is what lets the server adopt a payload tree filed under
 * the old name (server/cache-adopt.mjs) instead of re-decoding the world. Hashing the name too, as this
 * function used to, turned a spelling change into an afternoon of decoding: 627 579 payloads stranded
 * under the old name, the sweep calling them "a save this server does not serve", and a viewer that
 * merely looked slower.
 *
 * The seed still rides in the hash, so the same name over a different save is a different directory -
 * the thing that would otherwise let a copied cache (rsync and tar both keep mtimes, so the per-chunk
 * staleness check cannot see the swap) answer for a save that is not there any more. With no directory
 * to ask, the name is all the identity there is, and a hand-named cache gets one.
 */
export function worldTagFor({ dir = '', seed = '', override = '' } = {}) {
  const o = String(override ?? '').trim();
  const clean = o ? o.toLowerCase().replace(NOT_NAME, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48) : '';
  const d = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  // The hash says WHICH SAVE, and a name is not evidence about a save: pass the resolved directory and
  // the seed, and `--world-tag darkrpg-world` beside a `--worlds` slug of `darkrpg` become two names for
  // one cache the server can adopt rather than re-decode. With no directory to ask, the name is all there
  // is, so a hand-named cache still gets an identity of its own.
  const h = tagHash(`${d || clean}|${seed}`);
  return clean ? `${clean}.${h}` : `${dirLabel(d)}.${h}`;
}

/**
 * What a tag is allowed to look like, because it becomes one directory name in a tree the pruner walks
 * and deletes. Anything with a separator would let `--world-tag ../..` point the cache at the filesystem.
 */
export const WORLD_TAG_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isWorldTag(s) { return WORLD_TAG_OK.test(String(s ?? '')); }
