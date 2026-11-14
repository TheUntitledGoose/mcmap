/**
 * The card a chat link gets.
 *
 * Discord, Slack and Telegram fetch the page, read `<meta>` tags, and fetch the image the tag names.
 * They do not run the page, so a title set by JavaScript is invisible to them and a relative image URL
 * is meaningless. The server fills those tags in per request (see `worldd`); this file makes the picture
 * one of them points at.
 *
 * The committed card is drawn, not screenshotted: a screenshot is a claim about one framing of one save,
 * and this file ships with the code, so it says *what the thing is* — ground seen from an angle, a few
 * cubes lifted above it because the page can put a block back in time. No player, no coordinates, no
 * server's name on it.
 *
 * Your own deployment can show your own world instead:
 *
 *   node tools/make-embed.mjs --from build/lodshot.png     # -> build/embed.png (not committed)
 *   node tools/make-embed.mjs                              # -> web/img/embed.png (the drawn default)
 *
 * `worldd` serves `build/embed.png` when it exists and the drawn one otherwise, and the tags it writes
 * read the picture's own size rather than trusting either file's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePngRgba } from '../server/png.mjs';

const W = 1536, H = 768;

// A 5x7 blocky alphabet: the style the rest of the page's typography implies, and no font file to
// ship. Uppercase only, because uppercase needs fewer glyphs.
const G = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  ',': ['.....', '.....', '.....', '.....', '..##.', '..#..', '.#...'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '##...', '##...', '#.#..', '..##.', '..##.', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['#####', '#....', '#....', '.###.', '....#', '....#', '#####'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
};

function drawText(img, s, x, y, px, [r, g, b]) {
  let cx = x;
  for (const ch of s) {
    const gl = G[ch] ?? G[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (gl[row][col] !== '#') continue;
        fillRect(img, cx + col * px, y + row * px, px, px, [r, g, b]);
      }
    }
    cx += 6 * px;
  }
  return cx;                        // where the next run would start
}

function put(img, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
}

function fillRect(img, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(img, x, y, c);
}

/** Fill a convex-ish polygon by scanline; these are the rhombi and parallelograms of an isometric grid. */
function fillPoly(img, pts, c) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.ceil(Math.min(...ys))), y1 = Math.min(H - 1, Math.floor(Math.max(...ys)));
  const n = pts.length;
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) put(img, x, y, c);
    }
  }
}

function outline(img, pts, c) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)));
    for (let s = 0; s <= steps; s++) {
      put(img, Math.round(ax + ((bx - ax) * s) / steps), Math.round(ay + ((by - ay) * s) / steps), c);
    }
  }
}

// Sky: three flat bands, not a gradient. Flat colour keeps the card small, and banded sky is closer to
// how the game reads from far away anyway.
const img = new Uint8Array(W * H * 4);
let OUT_W = W, OUT_H = H;
const SKY = [[13, 19, 29], [16, 24, 35], [21, 31, 44]];
for (let y = 0; y < H; y++) {
  const band = SKY[y < H * 0.34 ? 0 : y < H * 0.62 ? 1 : 2];
  for (let x = 0; x < W; x++) put(img, x, y, band);
}

/* Isometric ground: a flat rhombus patch with a pool and some sand, big enough to read as terrain and
   small enough to leave the lower-left corner empty sky for the words. No raised cells - the faces a
   step needs made the patch look broken at this scale, and nothing about the page needs a cliff. */
const TW = 80, TH = 40;                  // rhombus width / height
const OX = W * 0.70, OY = H * 0.12;      // top corner of the patch
const N = 11;
const shade = (c, k) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
const cellTop = (i, j, lift) => [OX + ((i - j) * TW) / 2, OY + ((i + j) * TH) / 2 - lift * TH];

// deterministic pseudo-noise: same card on every machine that runs this tool
const hash = (i, j) => ((i * 73856093) ^ (j * 19349663)) % 97;
const pool = (i, j) => i >= 3 && i <= 5 && j >= 6 && j <= 8;
const shoreline = (i, j) => pool(i, j) && (i === 3 || i === 5 || j === 6 || j === 8);

const GRASS = [[74, 122, 62], [82, 130, 66]];
const SAND = [172, 158, 112];
const WATER = [[52, 96, 130], [58, 104, 140]];
const SHORE = [122, 118, 96];

for (let j = N - 1; j >= 0; j--) {
  for (let i = 0; i < N; i++) {
    const [cx, cy] = cellTop(i, j, 0);
    const top = [[cx, cy], [cx + TW / 2, cy + TH / 2], [cx, cy + TH], [cx - TW / 2, cy + TH / 2]];
    let fill;
    if (pool(i, j)) fill = WATER[hash(i, j) % WATER.length];
    else if (shoreline(i, j)) fill = SHORE;
    else if (hash(i, j) % 13 === 0) fill = SAND;
    else fill = GRASS[hash(i, j) % GRASS.length];
    fillPoly(img, top, fill);
  }
}

/* Three cubes lifted over the patch, each on a dotted line down to the cell it stands above: a placed
   block, and the moment it happened - which is what the time layer of the page looks like. */
function cube(cx, cy, s, top, side, edge) {
  const t = [[cx, cy], [cx + s / 2, cy + s / 4], [cx, cy + s / 2], [cx - s / 2, cy + s / 4]];
  const lift = s / 2;
  fillPoly(img, t, top);
  fillPoly(img, [[cx - s / 2, cy + s / 4], [cx, cy + s / 2], [cx, cy + s / 2 + lift], [cx - s / 2, cy + s / 4 + lift]], shade(side, 0.7));
  fillPoly(img, [[cx + s / 2, cy + s / 4], [cx, cy + s / 2], [cx, cy + s / 2 + lift], [cx + s / 2, cy + s / 4 + lift]], shade(side, 0.5));
  outline(img, t, edge);
  outline(img, [[cx - s / 2, cy + s / 4], [cx - s / 2, cy + s / 4 + lift], [cx, cy + s / 2 + lift],
    [cx + s / 2, cy + s / 4 + lift], [cx + s / 2, cy + s / 4]], edge);
}

function drop(cx, cy, toY, c) {
  for (let y = cy; y < toY; y += 10) for (let k = 0; k < 4 && y + k < toY; k++) put(img, cx, y + k, c);
}

for (const [i, j, lift, size, col] of [
  [7, 2, 3.4, 96, [[214, 158, 74], [176, 120, 52], [255, 214, 150]]],
  [4, 6, 5.2, 66, [[120, 176, 214], [86, 132, 170], [196, 232, 255]]],
  [9, 7, 2.2, 56, [[96, 160, 92], [70, 120, 68], [176, 226, 168]]],
]) {
  const [gx, gy] = cellTop(i, j, 0);
  const cy = gy + TH / 2 - lift * TH;
  cube(gx, cy, size, col[0], col[1], col[2]);
  drop(gx, cy + size / 2 + size / 2 + 4, gy + TH / 2, shade(col[2], 0.55));
}

// The words go over empty sky: the patch sits right and high, this corner stays clear.
drawText(img, 'THE WHOLE SAVE', 96, H - 232, 9, [214, 224, 236]);
drawText(img, 'IN A BROWSER TAB', 96, H - 146, 7, [150, 166, 188]);

// A card made from a screenshot: fill the frame, keep the middle (that is where a map view puts the
// interesting part), then put the same wordmark over a darkened foot so the words survive whatever the
// picture is. This writes to build/, which is not committed: your world stays yours.
function fromScreenshot(file) {
  const src = decodePng(fs.readFileSync(file));
  // decodePng answers {w, h, rgba}: a screenshot read as {width, height} produced an all-zero card that
  // still compressed to a few KB and looked like a bug in the drawing rather than a typo in the reader.
  const sw = src.w, sh = src.h, s = src.rgba ?? src.data;
  if (!sw || !sh || !s) throw new Error(`cannot read ${file}: not a PNG this decoder understands`);
  const k = Math.max(W / sw, H / sh);
  const cw = Math.round(sw * k), ch = Math.round(sh * k);
  const ox = Math.floor((cw - W) / 2), oy = Math.floor((ch - H) / 2);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + oy) / k));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + ox) / k));
      const i = (y * W + x) * 4, j = (sy * sw + sx) * 4;
      // a vertical darkening toward the foot, so the text has something to sit on without a hard band
      const t = Math.max(0, (y - H * 0.55) / (H * 0.45));
      const f = 1 - 0.55 * t;
      out[i] = s[j] * f; out[i + 1] = s[j + 1] * f; out[i + 2] = s[j + 2] * f; out[i + 3] = 255;
    }
  }
  drawText(out, 'THE WHOLE SAVE', 96, H - 210, 9, [214, 224, 236]);
  drawText(out, 'IN A BROWSER TAB', 96, H - 130, 7, [150, 166, 188]);
  return out;
}

// The tab icon, drawn here so it matches the card instead of being a mystery file. 128 square: crisp on
// a 2x display, still under 2 KB. A cube with a grass top, because that is what the page is.
function faviconPng() {
  const S = 128;
  const px = new Uint8Array(S * S * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const band = y < S * 0.5 ? [21, 31, 44] : [16, 24, 35];
      px[i] = band[0]; px[i + 1] = band[1]; px[i + 2] = band[2];
    }
  }
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  };
  const fill = (pts, c) => {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.ceil(Math.min(...ys)); y <= Math.floor(Math.max(...ys)); y++) {
      const xs = [];
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) put(x, y, c);
      }
    }
  };
  const cx = S / 2, cy = S * 0.30, s = S * 0.82;
  const top = [[cx, cy], [cx + s / 2, cy + s / 4], [cx, cy + s / 2], [cx - s / 2, cy + s / 4]];
  const lift = s * 0.42;
  fill(top, [96, 152, 78]);
  fill([[cx - s / 2, cy + s / 4], [cx, cy + s / 2], [cx, cy + s / 2 + lift], [cx - s / 2, cy + s / 4 + lift]], [64, 112, 62]);
  fill([[cx + s / 2, cy + s / 4], [cx, cy + s / 2], [cx, cy + s / 2 + lift], [cx + s / 2, cy + s / 4 + lift]], [44, 86, 50]);
  return { S, px };
}

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const from = arg('from', '');
let pixels = img;
if (from) {
  if (!fs.existsSync(from)) { console.error(`make-embed: no such screenshot: ${from}`); process.exit(2); }
  pixels = fromScreenshot(from);
}

// A card made of a screenshot is heavy: foliage noise does not compress, and 1536x768 of it is ~2 MB.
// That is one fetch per bot (cached on their CDN for months), not one per view, but --max-w is there for
// the day it bothers someone. The wordmark is part of the pixels, so it scales with the picture.
const maxW = Math.max(320, Math.min(W, +arg('max-w', W) || W));
if (pixels !== img && maxW < W) pixels = downscale(pixels, W, H, maxW);

function downscale(src, sw, sh, outW) {
  const k = sw / outW, oh = Math.round(sh / k);   // k is source-pixels per output-pixel, not the reverse
  const out = new Uint8Array(outW * oh * 4);
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * k), y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * k)));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * k), x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * k)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * outW + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  OUT_W = outW; OUT_H = oh;
  return out;
}

const out = arg('out', from ? path.join('build', 'embed.png')
  : (argv[0] && !argv[0].startsWith('--') ? argv[0] : path.join('web', 'img', 'embed.png')));
fs.mkdirSync(path.dirname(out), { recursive: true });
const bytes = encodePngRgba(OUT_W, OUT_H, pixels);
fs.writeFileSync(out, bytes);
const heavy = bytes.length > 400 * 1024
  ? `  (heavy: a bot fetches this once and caches it, but ${Math.round(OUT_W)}x${Math.round(OUT_H)} of screenshot noise is what it costs)`
  : '';
console.log(`${out}  ${OUT_W}x${OUT_H}  ${(bytes.length / 1024).toFixed(0)} KB${from ? `  from ${from}` : ''}${heavy}`);

// The tab icon goes with the drawn card, not with a screenshot: a map view crushed to 64 px is mush,
// and a missing favicon shows up as a 404 in the console of every probe run.
if (!from) {
  const { S, px } = faviconPng();
  const fav = arg('favicon', path.join('web', 'img', 'favicon.png'));
  fs.mkdirSync(path.dirname(fav), { recursive: true });
  const fb = encodePngRgba(S, S, px);
  fs.writeFileSync(fav, fb);
  console.log(`${fav}  ${S}x${S}  ${(fb.length / 1024).toFixed(1)} KB`);
}
