/**
 * Which save this tab is looking at, and how every request says so.
 *
 * A box can hold several saves (`--worlds <dir>`, `?world=<slug>`). The rule that makes that safe is
 * small: **a request that names a save must be answered by that save or refused.** A request that names
 * nothing gets the server's default, which is fine exactly as long as nothing in the tab thought it had
 * asked for something else.
 *
 * So the page keeps the slug once, at boot, and puts it on every URL it builds - chunk payloads, shells,
 * baked tiles, the ledger, the atlas, the skins. Not doing that is how a tab ends up drawing save A's
 * panel over save B's terrain: the requests quietly fall back, and the screen has no way to admit it.
 *
 * Deliberately not a cookie. A cookie would survive a second tab, and two tabs on two saves would each
 * read the other's choice on their next request. Here the choice lives in the tab's own module state, and
 * in the address bar, where a person can see it.
 */
let slug = '';

/** What the address bar said at boot, or what /meta answered when it named nothing. */
export function setWorldSlug(s) { slug = String(s ?? ''); return slug; }
export function worldSlug() { return slug; }

/** Put this tab's save on a server URL. No slug means "the default", and the URL stays as it was. */
export function withWorld(url) {
  if (!slug) return url;
  return url + (url.includes('?') ? '&' : '?') + 'world=' + encodeURIComponent(slug);
}

/**
 * The address of another save. This is a navigation, not a setting: switching a save means a different
 * atlas, different packs, different payload cache, so nothing about the running page may be kept.
 *
 * `dim` goes too - a dimension is a claim about a save, and the save you are switching to may not have
 * it. Everything else in the query stays, so a link that sets a zoom or a filter still sets it over
 * there; the new page picks that save's own default dimension and spawn.
 */
export function worldHref(next, search = '', path = '/') {
  const q = new URLSearchParams(search);
  q.delete('world');
  q.delete('dim');
  if (next) q.set('world', next);
  const qs = q.toString();
  return path + (qs ? `?${qs}` : '');
}

/**
 * The rows for a World choice: every save this server offers, labelled, with the ones that cannot render
 * left out and counted in `broken` so a panel can say why the list is shorter than the folder.
 */
export function worldOptions(worlds = []) {
  const good = worlds.filter((w) => !w.problem);
  const broken = worlds.filter((w) => w.problem);
  const labels = new Map();
  for (const w of good) labels.set(w.label, (labels.get(w.label) ?? 0) + 1);
  return {
    options: good.map((w) => ({
      value: w.slug,
      label: labels.get(w.label) > 1 || !w.label ? `${w.slug}` : w.label,
    })),
    broken: broken.map((w) => ({ slug: w.slug, why: w.problem })),
  };
}
