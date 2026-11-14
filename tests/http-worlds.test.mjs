// "two worlds on one server" can only be answered about data this repo does not carry: a save with two
// region files in it, and an asset pack baked from a game install. On a machine that has them this wrapper
// imports the suite unchanged; on a clone it registers one skipped test that says what is needed.
import test from 'node:test';
import { needWorlds } from './needs.mjs';

const need = needWorlds();
if (need) test('two worlds on one worldd', { skip: need }, () => {});
else await import('./http-worlds.data.mjs');
