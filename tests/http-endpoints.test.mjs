// "the HTTP contract of a live worldd" can only be answered about data this repo does not carry: a save, and packs baked from a
// save plus a copy of the game you own. On a machine that has them this wrapper imports the suite unchanged
// from http-endpoints.data.mjs; on a clone it registers one skipped test that says what to bake, instead of 17
// failures that look like bugs.
import test from 'node:test';
import { needServer } from './needs.mjs';

const need = needServer();
if (need) test('the HTTP contract of a live worldd', { skip: need }, () => {});
else await import('./http-endpoints.data.mjs');
