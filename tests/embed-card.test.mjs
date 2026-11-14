// A link into a chat should look like the thing it is. What a bot (Discord, Slack, Telegram) shows is
// decided by bytes the server sends - it fetches the HTML, reads <meta>, fetches the image - and never
// by the running page, which it cannot execute. So this is contract code with a visual payoff, and it is
// testable without a save, a pack or a browser: URL shape, tag shape, the marker in the page, the picture
// on disk, and the wiring that puts one inside the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { urlBase, pageUrl, pngSize, embedTags, fillEmbed } from '../shared/embed.mjs';
import { encodePngRgba, decodePng } from '../server/png.mjs';
import { WORLDD_FLAGS } from '../server/worldd-flags.mjs';

const wd = readFileSync('server/worldd.mjs', 'utf8').replace(/\r\n/g, '\n');
// M18 moved "open one world and know its packs" into its own file, so the card's facts - the level name,
// the version string, which picture to show - live there now. Assert against the file that holds them.
const wb = readFileSync('server/world-bundle.mjs', 'utf8').replace(/\r\n/g, '\n');
const page = readFileSync('web/index.html', 'utf8').replace(/\r\n/g, '\n');

test('the card describes the address the bot used, not a guess baked into a file', () => {
  // A box on a LAN has no domain. The Host header is the only thing that knows how this server was
  // reached, so the card uses it - which is also why it is character-checked before being echoed.
  assert.equal(urlBase({ host: '192.0.2.10:8765' }), 'http://192.0.2.10:8765');
  assert.equal(pageUrl({ host: '192.0.2.10:8765' }), 'http://192.0.2.10:8765/',
    'a URL with a query and no path is legal and reads as a mistake');
  assert.equal(pageUrl({ host: 'map.example.com', secure: true }), 'https://map.example.com/');
  // behind a proxy: the forwarded pair says what the client actually spoke
  assert.equal(pageUrl({ host: 'internal:8765', forwardedHost: 'map.example.com', forwardedProto: 'https, http' }),
    'https://map.example.com/');
  // a Host that is not a hostname is not echoed: it would be the caller writing the card for us
  assert.equal(pageUrl({ host: 'evil.example/<script>', fallback: '127.0.0.1:8765' }), 'http://127.0.0.1:8765/');
  assert.equal(pageUrl({ host: '', fallback: '127.0.0.1:8765' }), 'http://127.0.0.1:8765/');
  assert.equal(pageUrl({ host: '[fd00::12]:8765' }), 'http://[fd00::12]:8765/');
  // the query is part of the page's identity: a card made from a saved framing links back to it
  assert.equal(pageUrl({ host: 'h.test', search: '?dim=nether&tsec=100' }), 'http://h.test/?dim=nether&tsec=100');
  // a subpath behind a proxy keeps its prefix on both the page and the picture
  assert.equal(pageUrl({ host: 'h.test', override: 'https://map.example.com/mcmap/', path: '/' }),
    'https://map.example.com/mcmap/');
  assert.equal(urlBase({ host: 'h.test', override: 'https://map.example.com/mcmap/' }), 'https://map.example.com/mcmap',
    'so /embed.png hangs off the same prefix rather than the domain root');
  // and an explicit --embed-url outranks the headers, because a deployment knows better than a Host
  assert.equal(pageUrl({ host: 'internal:8765', override: 'https://map.example.com', search: '?a=1' }),
    'https://map.example.com/?a=1');
});

test('the tags are the ones the bots read, and hostile text stays quoted', () => {
  const t = embedTags({
    title: 'Dark & <rogue>', description: '4 dimensions', url: 'http://h.test/',
    image: 'http://h.test/embed.png', size: { w: 1536, h: 768 },
  });
  assert.match(t, /<meta property="og:type" content="website">/);
  assert.match(t, /<meta property="og:title" content="Dark &amp; &lt;rogue&gt;">/,
    'a save named with an angle bracket must not be able to write tags into the head');
  assert.match(t, /<meta property="og:image" content="http:\/\/h\.test\/embed\.png">/);
  // declared sizes: Discord sizes the card from the tag when it has one, and guesses when it does not
  assert.match(t, /<meta property="og:image:width" content="1536">/);
  assert.match(t, /<meta property="og:image:height" content="768">/);
  assert.match(t, /<meta name="twitter:card" content="summary_large_image">/, 'the wide card, not the thumbnail');
});

test('no picture means no image tag, not a card pointing at nothing', () => {
  const t = embedTags({ title: 'a', description: 'b', url: 'http://h.test/' });
  assert.doesNotMatch(t, /og:image/, 'content="null" reads as a broken preview, not a plain one');
  assert.doesNotMatch(t, /twitter:image/);
  assert.match(t, /<meta name="twitter:card" content="summary">/, 'still a card, just the small kind');
});

test('a PNG reports its own size, so the tags cannot drift from the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'embed-'));
  try {
    const png = readFileSync('web/img/embed.png');
    assert.deepEqual(pngSize(png), { w: 1536, h: 768 });
    // the same bytes handed over as a plain view rather than a Node Buffer still answers
    const view = new Uint8Array(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
    assert.deepEqual(pngSize(view), { w: 1536, h: 768 });
    assert.equal(pngSize(Buffer.from('GIF89a' + '\0'.repeat(30))), null, 'not a PNG is not a size');
    assert.equal(pngSize(Buffer.alloc(4)), null, 'a truncated file is not a size');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the page carries exactly one marker for the server to fill', () => {
  assert.equal(page.split('<!--embed-->').length - 1, 1,
    'zero means the card silently went blank, two means one of them is nobody\'s');
  assert.match(page, /<meta name="description" content="[^"]{40,}">/,
    'a page served by something other than worldd still says what it is');
  // A missing favicon is not cosmetic here: it is a 404 in the console of every probe run, and a probe
  // reports console errors as "the screenshot is probably blank".
  assert.ok(page.includes('<link rel="icon" href="/img/favicon.png">'), 'the tab icon is named, not begged for');
  const fav = decodePng(readFileSync('web/img/favicon.png'));
  assert.equal(fav.w, fav.h, 'a tab icon that is not square gets stretched');
  assert.ok(fav.w >= 64 && fav.w <= 256, `the favicon is ${fav.w}px, which a display either blurs or wastes`);
  const one = fillEmbed('<head><!--embed--></head>', '<!--embed-->', '<meta name="x" content="1">');
  assert.ok(one.filled);
  assert.match(one.html, /<head><meta name="x" content="1"><\/head>/);
  // a replacement containing $ must not be eaten: pageUrl output can carry "$" in a saved framing
  const dollar = fillEmbed('<i><!--embed--></i>', '<!--embed-->', 'price $& and $1');
  assert.equal(dollar.html, '<i>price $& and $1</i>',
    'String.replace treats $ in a plain replacement as a reference; the tag text is not a template');
  assert.equal(fillEmbed('<i>nothing</i>', '<!--embed-->', 'x').filled, false, 'no marker: say so');
  assert.equal(fillEmbed('<i><!--embed--><!--embed--></i>', '<!--embed-->', 'x').filled, false, 'two: say so');
});

test('worldd writes the tags into the page and serves the picture the tags name', () => {
  assert.match(wd, /import \{ urlBase, pageUrl, embedTags, pngSize, fillEmbed \} from '\.\.\/shared\/embed\.mjs';/,
    'the policy lives where it can be tested without a save');
  assert.match(wd, /const EMBED_MARK = '<!--embed-->';/, 'the marker has to match the page byte for byte');
  assert.match(wd, /fillEmbed\(html, EMBED_MARK, embedHead\(req, u, W\)\)/,
    'and the card is written for the world this request is about');
  assert.match(wd, /if \(rel === 'index\.html'\) return send\(req, res, 200, embedPage\(req, u, W\)/,
    'the page goes through the filler, not straight off disk');
  assert.match(wd, /if \(u\.pathname === '\/embed\.png'\)/, 'the card needs a server that serves the image');
  assert.match(wd, /if \(!r\.filled && embedWarned !== r\.marks\)/,
    'a page that lost its marker is reported once, not guessed around');
  for (const f of ['embed-url', 'embed-title', 'embed-desc', 'embed-image']) {
    assert.match(wd, new RegExp(`arg\\('${f}'`), `--${f} is parsed`);
    assert.ok(WORLDD_FLAGS.includes(f), `WD_${f.toUpperCase().replace(/-/g, '_')} has to be a real flag or the boot refuses it`);
  }
  // What the card calls the world: this save's LevelName is literally "world", which names a folder and
  // not a server, and level.dat's Version.Id is the protocol number (3465), not a version anyone knows.
  assert.match(wb, /\/\^\(world\|world_nether\|world_the_end\|new world\|\)\?\$\/i/,
    'a save called "world" has to be named by the directory or slug holding it, or every card says "world"');
  assert.match(wb, /version: String\(d\.Version\?\.Name/, '/meta must call 1.20.1 what a person calls it');
  assert.match(wb, /protocol: Number\(d\.Version\?\.Id/, 'and keep the protocol number under its own name');
  assert.match(wd, /world: W\.paths\.world, slug: W\.slug, label: W\.label/,
    'the page is told which world it is showing');
});

test('your own deployment can show your own world, and it does not need a rebuild', () => {
  // build/ is not committed, so a card made from a screenshot of a real save stays on that box
  const order = wb.match(/function embedImageFor[\s\S]*?const cand = \[[^\]]+\]/)?.[0] ?? '';
  assert.ok(order, 'the card search order exists in one place (embedImageFor in world-bundle.mjs)');
  const at = (s) => order.indexOf(s);
  assert.match(order, /override,/, 'a named image wins');
  assert.ok(at("paths.embed ? path.join(paths.embed, 'embed.png')") > at('override,'),
    'then this world\'s own card in its pack folder');
  assert.ok(at("'build/embed.png'") > at('paths.embed'),
    'then a card sitting in the deployment\'s build dir, so a local run picks up what you just made');
  assert.match(order, /paths\.defaultEmbed/,
    'and last the drawn default that ships with the code');
  assert.match(wd, /defaultEmbed: DEFAULT_CARD/, 'worldd names that default');
  assert.match(wd, /const DEFAULT_CARD = path\.join\(WEB, 'img', 'embed\.png'\);/,
    'and it is the committed drawing, not a screenshot of somebody\'s save');
});

test('the stack can carry a card without a rebuild, and mounts it where the server looks', () => {
  const compose = readFileSync('compose.yaml', 'utf8').replace(/\r\n/g, '\n');
  assert.match(compose, /source: \$\{MCMAP_PACKS:-\.\/packs\}\/embed\n\s+target: \/srv\/app\/build\/embed\n\s+read_only: true/,
    'a card has to arrive as a pack, the way the shells and the skins do, not as a rebuild');
  // Bind-mounting a host path that does not exist CREATES a directory there, so the server has to look
  // for a file inside the mount rather than at the mount point itself.
  assert.ok(wb.includes("path.join(paths.embed, 'embed.png')"),
    'the mounted card is a file in the pack, not the pack directory');
});

test('a card made from a screenshot is the screenshot, not a blank canvas', () => {
  // The first version of this read a PNG as {width, height} when the decoder answers {w, h}: the card
  // came out uniformly black, still 1536x768, and 8 KB. Size alone would never have noticed.
  const dir = mkdtempSync(path.join(tmpdir(), 'embed-from-'));
  try {
    // a stand-in screenshot: per-pixel noise at card resolution, which is what a map view full of
    // foliage and dithered textures is to a PNG - nothing to predict from a neighbour
    const sw = 1536, sh = 768, px = new Uint8Array(sw * sh * 4);
    let h = 0x9e3779b9;
    for (let i = 0; i < px.length; i += 4) {
      h = (Math.imul(h ^ (h >>> 15), 0x85ebca6b) + 1) >>> 0;
      px[i] = h & 255; px[i + 1] = (h >>> 8) & 255; px[i + 2] = (h >>> 16) & 255; px[i + 3] = 255;
    }
    const src = path.join(dir, 'shot.png');
    writeFileSync(src, encodePngRgba(sw, sh, px));

    const full = path.join(dir, 'card.png');
    execFileSync(process.execPath, ['tools/make-embed.mjs', '--from', src, '--out', full], { stdio: 'pipe' });
    const card = decodePng(readFileSync(full));
    assert.deepEqual({ w: card.w, h: card.h }, { w: 1536, h: 768 });
    let lo = 255, hi = 0, sum = 0;
    for (let i = 0; i < card.rgba.length; i += 4) {
      const l = (card.rgba[i] + card.rgba[i + 1] + card.rgba[i + 2]) / 3;
      lo = Math.min(lo, l); hi = Math.max(hi, l); sum += l;
    }
    assert.ok(hi - lo > 60, `the card is flat (${lo}..${hi}): the source picture did not make it in`);
    assert.ok(readFileSync(full).length > 100 * 1024,
      'a card of a noisy map view cannot compress to almost nothing - that was the blank-card symptom');

    const small = path.join(dir, 'small.png');
    execFileSync(process.execPath, ['tools/make-embed.mjs', '--from', src, '--out', small, '--max-w', '768'],
      { stdio: 'pipe' });
    const tiny = decodePng(readFileSync(small));
    assert.equal(tiny.w, 768, '--max-w did not scale the card');
    assert.equal(tiny.h, 384, 'and scaling must keep the 2:1 shape, not letterbox it');
    assert.ok(readFileSync(small).length < readFileSync(full).length, 'scaling did not make it smaller');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the default card exists, is big enough for a wide preview, and redraws identically', () => {
  const png = readFileSync('web/img/embed.png');
  const sz = pngSize(png);
  assert.ok(sz, 'the committed card must be a PNG');
  // under ~1200x630 a "large" card comes out soft: Discord upscales it to fill the embed width
  assert.ok(sz.w >= 1200 && sz.h >= 600, `the committed card is ${sz.w}x${sz.h}, too small for a large preview`);
  assert.ok(png.length < 400 * 1024, `a card is fetched by every bot on every unfurl: ${(png.length / 1024) | 0} KB is enough`);
  // deterministic: the same input must not produce a different picture every build, or the repo shows
  // a diff nobody made
  const dir = mkdtempSync(path.join(tmpdir(), 'embed-make-'));
  try {
    const outs = [1, 2].map((k) => path.join(dir, `c${k}.png`));
    for (const o of outs) {
      // --favicon into the temp dir: the tool also draws the tab icon, and a test must not write into the repo
      execFileSync(process.execPath, ['tools/make-embed.mjs', o, '--favicon', path.join(dir, 'fav.png')],
        { stdio: 'pipe' });
    }
    const a = readFileSync(outs[0]), b = readFileSync(outs[1]);
    assert.equal(a.length, b.length, 'the drawing tool is not deterministic');
    assert.deepEqual([...a], [...b]);
    assert.deepEqual(pngSize(a), sz, 'the tool no longer draws the committed size');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
