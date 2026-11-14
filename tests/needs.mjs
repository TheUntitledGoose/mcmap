// Which local data a test can actually see, and the honest skip when it cannot.
//
// This repo's test suite comes in two halves. One half tests formats, policies and the mesher out of
// synthetic bytes and runs anywhere. The other half asks questions about THIS save - "does the mesher put
// glass on the cutout layer", "does a body stand on a floor", "does the cache re-serve identical bytes" -
// and needs data that is derived from a save and a game install and therefore is not in git: `build/assets`
// (baked from your own 1.20.1 jar and the save's mod jars), the save itself, the mod jars, the ledger pack,
// the fetched skin pack.
//
// A test that cannot see its input must say so and skip, not fail: a clone of this repo should be able to
// run the suite and see a green result with an honest count of what waited for data.

import { existsSync, readFileSync } from 'node:fs';

export const WORLD = process.env.WD_WORLD || 'DarkRPG/world';
export const MODS = process.env.WD_MODS || 'DarkRPG/mods';
export const ASSETS = process.env.WD_ASSETS || 'build/assets';
export const LEDGER = 'build/ledger';
export const SKINS = 'build/skins';

export const HAVE = {
  assets: existsSync(`${ASSETS}/atlas.json`) && existsSync(`${ASSETS}/geometry.bin`),
  save: existsSync(`${WORLD}/region`),
  jars: existsSync(MODS),
  ledger: existsSync(`${LEDGER}/meta.json`),
  skins: existsSync(`${SKINS}/manifest.json`),
  packs: existsSync('build/shells') && existsSync('build/lods'),
};

const why = (what) => `needs ${what}: derived from a save and a game install, not in git`;
export const needAssets = () => (HAVE.assets ? false : why(`${ASSETS} (npm run pack:assets after npm run census)`));
export const needSave = () => (HAVE.save ? false : why(`the save at ${WORLD} (or set WD_WORLD)`));
export const needData = () => (HAVE.assets && HAVE.save ? false
  : why(`${ASSETS} and the save at ${WORLD} (npm run bake, or point WD_WORLD at a save)`));
export const needJars = () => (HAVE.jars ? false : why(`the mod jars at ${MODS}`));
export const needLedger = () => (HAVE.ledger ? false : why('the baked ledger pack (npm run bake:ledger)'));
export const needSkins = () => (HAVE.skins ? false : why('the skin pack (node tools/fetch-skins.mjs)'));
export const needPacks = () => (HAVE.packs ? false : why('the baked far packs (npm run bake:shells && npm run bake:lod)'));
export const needServer = () => (HAVE.save && HAVE.packs ? false
  : why(`a live worldd: the save at ${WORLD} and the baked packs (npm run bake)`));
export const needAssetsLedger = () => (HAVE.assets && HAVE.ledger ? false
  : why(`${ASSETS} and ${LEDGER} (npm run bake, then npm run bake:ledger)`));

// Two saves built out of one: the multi-world data tests copy two region files, so they need a save
// with those two regions in it, plus an atlas for both worlds to share.
export const needWorlds = () => (HAVE.assets && HAVE.save
  && existsSync(`${WORLD}/region/r.0.0.mca`) && existsSync(`${WORLD}/region/r.0.1.mca`) ? false
  : why(`${ASSETS} and a save with world/region/r.0.0.mca and r.0.1.mca (the multi-world tests copy both)`));

/** The shape `classifyStates` / `buildStateIds` accept when there is nothing baked to read. */
export const EMPTY_ATLAS = { states: [], textures: [], quads: [], variants: [], layers: [] };

/**
 * Read the baked asset pack the page uses. Returns null when it is not here, so a test file can hold one
 * `const A = loadAssets()` and answer its own skip condition instead of dying at import.
 */
export function loadAssets(dir = ASSETS) {
  const atlasPath = `${dir}/atlas.json`;
  const geoPath = `${dir}/geometry.bin`;
  if (!existsSync(atlasPath) || !existsSync(geoPath)) return null;
  const json = JSON.parse(readFileSync(atlasPath, 'utf8'));
  const buf = readFileSync(geoPath);
  return { json, buf, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}
