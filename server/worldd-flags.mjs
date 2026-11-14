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
  'packs', 'lods', 'cache-max-gb', 'cache-keep-h', 'cache-sweep', 'cache-reconcile',
  'slow-ms', 'heartbeat',
];
