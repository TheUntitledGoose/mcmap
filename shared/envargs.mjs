/**
 * Command line, from the environment.
 *
 * `worldd` already takes every knob as a flag. A container does not really want flags: what you set
 * in Portainer (or `docker run -e`, or compose `environment:`) is variables, and a long command
 * line baked into an image is one typo away from an invisible misconfiguration. So the environment
 * is translated into exactly the flags the same server already reads - no second config system, no
 * second set of defaults to drift.
 *
 *   WD_PORT=8765            -> --port 8765
 *   WD_LEDGER=none          -> --ledger none
 *   WD_CACHE_MAX_GB=6       -> --cache-max-gb 6
 *   WD_CACHE=none           -> --cache none
 *
 * Underscores become dashes, so a flag name maps to an env name mechanically. A command-line flag
 * still wins over the environment, because these pairs go in *front* of argv and the parser takes
 * the first match.
 *
 * Two rules keep the translation from lying:
 *
 * - An empty value means "not set". `-e WD_CACHE=` must not become `--cache` swallowing the next
 *   argument, which would silently re-point every other flag after it.
 * - A flag whose meaning is *presence* rather than a value cannot be spelled from a variable
 *   unambiguously (`WD_FOO=1` - flag, or the number 1?). worldd has no such flag today. If one is
 *   added, name it in the `presence` set at the place its flag is parsed, next to the flag itself.
 */

export function envArgs(env = process.env, { prefix = 'WD_', presence = new Set() } = {}) {
  const out = [];
  for (const [key, raw] of Object.entries(env || {})) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue;
    const name = key.slice(prefix.length).toLowerCase().replace(/_/g, '-');
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) continue; // not a flag name we would recognise
    const value = String(raw ?? '').trim();
    if (presence.has(name)) {
      if (value && value !== '0' && value.toLowerCase() !== 'false') out.push(`--${name}`);
      continue;
    }
    if (!value) continue;
    out.push(`--${name}`, value);
  }
  return out;
}
