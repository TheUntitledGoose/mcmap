// What is allowed to leave this machine. This viewer was built on a private multiplayer save, so the
// publishable set is decided by what git tracks, and the things that must never be tracked are: the save
// itself (its region files, its `level.dat` seed, its per-player `.dat` files), the server logs (they carry
// player IP addresses), the mod and Mojang jars, the derived skin pack (faces belong to other people), the
// payload cache, and the working notes (they name real players and quote coordinates).
//
// History is checked too, because a push sends every commit and not just HEAD: 2.7 GB of server root once
// sat in this repo's history, and a repo that has held it is a repo that can hand it over by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const tracked = git(['ls-files']).split('\n').filter(Boolean);

const forbiddenTracked = [
  /^DarkRPG\//,                 // the save and the server root: 3.6 GB of other people's world
  /^build\/cache/,              // derived, huge, and keyed to this machine
  /^build\/skins\/(?!\.keep$)/, // fetched faces: the .keep file is the only thing of ours
  /^build\/ledger\/actions\.bin$/, // a build input with raw rows, 32 MB
  /^build\/shells\/(?!\.keep$)/, /^build\/lods\/(?!\.keep$)/, /^build\/assets\/(?!\.keep$)/,
    // baked from jars you own, so not ours to ship. The .keep files ARE ours: they exist so the image's
    // COPY of a pack directory does not die on a clone that has never baked anything.
  /^\.private\//,               // the real player handles
  /^deploy\//,
];

// The only pictures that belong to this repo. `.png` is on the forbidden-extension list in the history
// check below because probe screenshots used to be the biggest things lying around in history; these two
// are different in kind - drawn by tools/make-embed.mjs, 15 KB and 0.6 KB, no world in them - and a clone
// without them is a clone whose link card and tab icon are missing.
const OUR_PNG = /^web\/img\/(embed|favicon)\.png$/;

test('the tracked set carries no save, no cache, no jars, no faces, no notes', () => {
  const bad = tracked.filter((f) => forbiddenTracked.some((re) => re.test(f)));
  assert.deepEqual(bad, [], `these would be published: ${bad.slice(0, 10).join(', ')}`);
});

test('the working notes are local-only, and say so in .gitignore', () => {
  for (const f of ['HANDOFF.md', 'PLAN.md']) {
    assert.ok(!tracked.includes(f), `${f} is tracked: it names real players`);
    const ignored = git(['check-ignore', '-v', f]).trim();
    assert.ok(ignored.includes(f), `${f} is not git-ignored, so git add -A would bring it back`);
  }
});

test('no real player handle survives in a tracked file', () => {
  const mapfile = '.private/names.json';
  if (!existsSync(mapfile)) {
    // The mapping is deliberately not published. Without it there is nothing to check against, and that is
    // an honest skip rather than a vacuous pass - tools/publish.mjs refuses to build a tree in this state.
    console.log('skip: no .private/names.json on this checkout (expected on a clone), so no handle to look '
      + 'for; tools/publish.mjs will refuse to build a publish tree here');
    return;
  }
  const names = Object.keys(JSON.parse(readFileSync(mapfile, 'utf8')).map);
  const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const hits = tracked.filter((f) => {
    try { return re.test(readFileSync(f, 'utf8')); } catch { return false; }
  });
  assert.deepEqual(hits, [], `real handles in: ${hits.join(', ')} - run node tools/pseudonymise.mjs`);
});

test('history carries no save, no server binaries, no notes', () => {
  // Every object every commit can reach. A single one of these means a push would upload it.
  const objs = git(['rev-list', '--objects', '--all']).split('\n').filter(Boolean)
    .map((l) => l.slice(41));
  const bad = objs.filter((p) => /^(DarkRPG|HANDOFF\.md|PLAN\.md|\.private)(\/|$)/.test(p)
    || (/\.(jar|mca|sqlite|dat|dat_old|log|log\.gz|ledpack|bin|png)$/.test(p) && !OUR_PNG.test(p))
    || /^build\/(cache|skins\/(?!\.keep$)|shells\/(?!\.keep$)|lods\/(?!\.keep$)|assets\/(?!\.keep$)|msg_|doc_)/.test(p));
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} unpublished things are still in history, e.g. `
    + `${bad.slice(0, 3).join(', ')} - rewrite history before any push (git filter-repo --path DarkRPG `
    + `--path HANDOFF.md --path PLAN.md --invert-paths)`);
});

test('the pictures the repo does own are tracked, and only those', () => {
  for (const f of ['web/img/embed.png', 'web/img/favicon.png']) {
    assert.ok(tracked.includes(f), `${f} is what the card's tags and the tab point at: untracked, a clone has no picture`);
  }
  // and everything else that looks like a picture on disk stays out: build/embed.png is a screenshot of a
  // private save, and web/img is small enough to audit by eye
  const pics = tracked.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
  assert.deepEqual(pics, ['web/img/embed.png', 'web/img/favicon.png'],
    `images in the publishable set: ${pics.join(', ')}`);
});

test('the repo does not carry a dependency lock that needs the network to read', () => {
  // `npm test` on a fresh clone should be about the code, not about the internet.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts.test, 'no test script');
  assert.ok(tracked.includes('package-lock.json'), 'package-lock.json unpinned: an install can drift');
});
