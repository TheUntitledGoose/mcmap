import fs from 'node:fs';
import path from 'node:path';

/**
 * The one directory a save is, on this machine.
 *
 * The payload cache's identity hashes this, so it must not depend on how the save was reached: a
 * junction, a symlink, a bind mount, a `..` in the middle, or the same path spelled with backslashes
 * are all one save and must land on one cache directory (see shared/world-tag.mjs and
 * server/cache-adopt.mjs). `realpath` is the question "which directory is this", asked the way the
 * filesystem answers it.
 *
 * The fallback is deliberate: a save that is not readable (missing, mid-deploy, a permission the
 * container does not have) should still get a stable tag from its spelling rather than throw on the way
 * to a boot message that explains the real problem. It has no payloads to be wrong about yet.
 */
export function canonicalDir(p) {
  const abs = path.resolve(String(p ?? '.'));
  try { return fs.realpathSync(abs); } catch { return abs; }
}
