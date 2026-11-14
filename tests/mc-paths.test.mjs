// Where the vanilla jar is looked for. This matters twice over: a clone on a different OS has to find its
// own install without editing code, and this repo is public, so the default must never be one person's
// home folder frozen into a string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { minecraftDir, vanillaJar, vanillaJarHint, MC_VERSION } from '../server/mc-paths.mjs';

// Built with path.join on both sides so the assertions hold whatever separator this box runs on, and
// resolved because the module resolves: on Windows a bare `/srv/home` means "\srv\home on the current
// drive", and an assertion written as a bare string would be a path the module cannot produce.
const home = path.resolve(path.sep, 'srv', 'home');
const R = (...seg) => path.resolve(path.join(...seg));

test('the default follows the launcher layout of the platform, not of the machine I typed it on', () => {
  const win = minecraftDir({ homedir: () => home, platform: 'win32',
    env: { APPDATA: path.join(home, 'AppData') } });
  assert.equal(win, path.join(home, 'AppData', '.minecraft'));
  assert.equal(minecraftDir({ homedir: () => home, platform: 'win32', env: {} }),
    path.join(home, 'AppData', 'Roaming', '.minecraft'), 'no APPDATA: the Roaming profile, like the launcher');
  assert.equal(minecraftDir({ homedir: () => home, platform: 'darwin', env: {} }),
    path.join(home, 'Library', 'Application Support', 'minecraft'));
  assert.equal(minecraftDir({ homedir: () => home, platform: 'linux', env: {} }),
    path.join(home, '.minecraft'));
  assert.equal(vanillaJar({ homedir: () => home, platform: 'linux', env: {} }),
    path.join(home, '.minecraft', 'versions', MC_VERSION, `${MC_VERSION}.jar`),
    'the version jar, which is where blockstates and textures actually live');
});

test('an install in an odd place is one variable away, not a code edit', () => {
  assert.equal(minecraftDir({ env: { MC_DIR: path.join(path.sep, 'games', 'vanilla') },
    homedir: () => path.join(path.sep, 'nope'), platform: 'linux' }),
    R(path.sep, 'games', 'vanilla'));
  assert.equal(vanillaJar({ env: { VANILLA_JAR: path.join(path.sep, 'games', '1.20.1.jar'),
    MC_DIR: path.join(path.sep, 'ignored') } }),
    R(path.sep, 'games', '1.20.1.jar'), 'VANILLA_JAR outranks a guessed layout, as it must');
  // The hint has to name the fix, because "no such file" alone sends you reading source.
  const hint = vanillaJarHint({ env: {}, homedir: () => home, platform: 'linux' });
  assert.match(hint, /VANILLA_JAR=/);
  assert.match(hint, /MC_DIR=/);
});

test('no source file in this project hardcodes a path through a home folder', () => {
  // The regression this guards is the obvious one: a developer's absolute path, committed because it
  // happened to be true on one machine. tests/publish-clean.test.mjs looks for the same shape in history.
  const files = ['server/asset-index.mjs', 'server/pack-assets.mjs', 'server/mc-paths.mjs',
    'tools/colormap-mean.mjs', 'tests/codecs.test.mjs', 'tests/models.test.mjs'];
  const shape = /[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]/;
  const hits = files.filter((f) => shape.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], `hardcoded home paths in: ${hits.join(', ')}`);
});
