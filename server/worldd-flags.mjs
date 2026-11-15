/**
 * worldd's flag list, in one place.
 *
 * The server reads its settings as `--name value` pairs, and the container reads the same settings
 * as `WD_NAME=value` variables (shared/envargs.mjs). Both need to know the real names: the server to
 * refuse a `WD_*` that spells nothing, and the image/stack tests to notice when a documented
 * variable has stopped being a flag. A flag added to the server but not listed here is caught by
 * tests/container-contract.test.mjs.
 */
export const WORLDD_FLAGS = [
  'world', 'assets', 'cache', 'web', 'vendor', 'ledger', 'port', 'host',
  // M18: a folder of worlds (WD_WORLDS) instead of one save, and which of them a request gets when it
  // does not name one. See server/world-registry.mjs; the page asks with ?world=<slug>.
  'worlds', 'world-default', 'worlds-scan',
  // How many of the worlds in that folder may stand open at once (WD_WORLDS_MAX, default 4). The rest are
  // listed and opened by the first request that names them; `0` opens all of them. See park()/openNow().
  'worlds-max',
  'packs', 'lods', 'skins', 'cache-max-gb', 'cache-keep-h', 'cache-sweep', 'cache-reconcile',
  // rename a payload tree this save owns under another name, at boot (WD_CACHE_ADOPT, default on): the
  // identity hash is the resolved directory plus the seed, so the adoption is provable, not guessed.
  // See server/cache-adopt.mjs.
  'cache-adopt',
  'slow-ms', 'heartbeat',
  // which save the payload cache belongs to, when the directory and its seed are not answer enough
  // (M18's world dropdown names worlds, so the cache should carry that name). See shared/world-tag.mjs.
  'world-tag',
  // what a chat link becomes: the public address, the two sentences, and which picture. See shared/embed.mjs.
  'embed-url', 'embed-title', 'embed-desc', 'embed-image',
];
