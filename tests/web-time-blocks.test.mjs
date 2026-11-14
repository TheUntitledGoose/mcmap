// "block-shaped time markers, on the baked atlas and ledger" can only be answered about data this repo does not carry: a save, and packs baked from a
// save plus a copy of the game you own. On a machine that has them this wrapper imports the suite unchanged
// from web-time-blocks.data.mjs; on a clone it registers one skipped test that says what to bake, instead of 17
// failures that look like bugs.
import test from 'node:test';
import { needAssetsLedger } from './needs.mjs';

const need = needAssetsLedger();
if (need) test('block-shaped time markers, on the baked atlas and ledger', { skip: need }, () => {});
else await import('./web-time-blocks.data.mjs');
