// "lit and unlit meshing, with the baked rules" can only be answered about data this repo does not carry: a save, and packs baked from a
// save plus a copy of the game you own. On a machine that has them this wrapper imports the suite unchanged
// from web-light.data.mjs; on a clone it registers one skipped test that says what to bake, instead of 17
// failures that look like bugs.
import test from 'node:test';
import { needAssets } from './needs.mjs';

const need = needAssets();
if (need) test('lit and unlit meshing, with the baked rules', { skip: need }, () => {});
else await import('./web-light.data.mjs');
