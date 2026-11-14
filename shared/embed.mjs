/**
 * What a link preview shows.
 *
 * Discord, Slack and Telegram do not run the page: they fetch the HTML, read the `<meta>` tags, and
 * fetch the image one of those tags names. Two consequences decide the design:
 *
 * - a title or description set by JavaScript is invisible to them, so the tags have to be in the bytes
 *   the server sends back, and
 * - the image URL has to be absolute, and absolute to *the address the bot is calling*, which the
 *   server knows from the request but the file on disk cannot.
 *
 * So the marker in `web/index.html` is replaced per request, from the Host the caller used. A box
 * reached as a LAN IP, as a tailscale name, or through a reverse proxy then describes itself correctly
 * without being told where it lives. `override` exists for the case where the Host header is a lie (a
 * proxy that strips it) - and note that a Host is caller-supplied: whoever crafts one controls the URL
 * this card prints, which is why it is escaped, character-checked, and overridable.
 *
 * Kept out here, rather than inline in the server, so it can be tested without a save, a pack, or a
 * browser: none of these functions touch the network, the filesystem or the DOM.
 */

/** The first value of a possibly-comma-list header ("x-forwarded-proto: https, http"). */
const first = (v) => String(v ?? '').split(',')[0].trim();

/** A Host worth echoing: hostname/IPv6-in-brackets plus optional port, nothing else. */
const HOST_OK = /^[A-Za-z0-9.\-_]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/;

/**
 * The address this request is being called at, without a path.
 *
 * `override` (from `--embed-url`) wins outright: a deployment behind a proxy that rewrites or drops
 * `Host` should say where it is public rather than have the server guess from a header it did not send.
 */
export function urlBase({ override, forwardedHost, host, forwardedProto, secure, fallback } = {}) {
  if (override) return String(override).replace(/\/+$/, '');
  const h = first(forwardedHost) || first(host);
  const usable = HOST_OK.test(h) ? h : '';
  const proto = first(forwardedProto) || (secure ? 'https' : 'http');
  return `${proto}://${usable || fallback}`;
}

/**
 * The absolute URL of the page being fetched.
 *
 * The path is part of the answer: `http://host?dim=nether` is legal and reads as a mistake, and a card
 * that links to it is a link a person cannot edit. The query survives because a saved framing is part of
 * what the card is showing.
 */
export function pageUrl(o = {}) {
  return urlBase(o) + (o.path || '/') + (o.search || '');
}

/** Width and height from a PNG's IHDR, without decoding it. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const dv = typeof buf.readUInt32BE === 'function'
    ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    : { w: (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19], h: (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23] };
  return dv.w > 0 && dv.h > 0 ? dv : null;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * The tag block itself.
 *
 * `og:*` is what Discord reads (it has understood these since 2015 and ignores `twitter:*` otherwise);
 * `twitter:card` is what Slack and some link previews ask for, and costs nothing to include. The image
 * size is declared when known because Discord sizes the card from the tag when it has one, and falls
 * back to an aspect it guessed when it does not - a tall screenshot otherwise gets cropped at the top.
 */
export function embedTags({ title, description, url, image, size, site = 'worldd' } = {}) {
  const row = (k, v, prop) => `<meta ${prop ? 'property' : 'name'}="${k}" content="${esc(v)}">`;
  const out = [
    row('og:type', 'website', true),
    row('og:site_name', site, true),
    row('og:title', title, true),
    row('og:description', description, true),
    row('og:url', url, true),
  ];
  // No picture, no image tags: a card pointing at "null" is worse than a card with no picture, because
  // the bot then reports a broken preview instead of a plain one.
  if (image) {
    out.push(row('og:image', image, true));
    if (size) {
      out.push(row('og:image:width', size.w, true), row('og:image:height', size.h, true),
        row('og:image:type', 'image/png', true));
    }
    out.push(row('twitter:image', image));
  }
  out.push(row('twitter:card', image ? 'summary_large_image' : 'summary'),
    row('twitter:title', title), row('twitter:description', description));
  return out.join('\n');
}

/**
 * Put the tags into the page.
 *
 * The marker must appear exactly once: zero means the page stopped carrying it and the card silently
 * went blank, and two means the second is a copy nobody is maintaining. Both are reported rather than
 * guessed at, and the html comes back unchanged so the page still works - a link preview is not worth
 * breaking a viewer over.
 */
export function fillEmbed(html, mark, tags) {
  const n = html.split(mark).length - 1;
  if (n !== 1) return { html, filled: false, marks: n };
  return { html: html.replace(mark, () => tags), filled: true, marks: n };
}
