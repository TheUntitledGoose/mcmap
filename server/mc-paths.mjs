// Where a Minecraft install lives on this machine.
//
// There used to be a literal `the old hardcoded path\...` in five files here. That is somebody's
// username, in a public repo, on a machine that may not exist any more: personal data that stops being
// true the day it is copied. So the default is derived per platform instead, and the only way to point
// at a jar by hand is to say so on purpose (VANILLA_JAR / MC_DIR).
import os from 'node:os';
import path from 'node:path';

/** The vanilla version this project was built against. Mod jars are matched against it. */
export const MC_VERSION = '1.20.1';

/**
 * The launcher's `.minecraft` directory for a platform. `MC_DIR` overrides everything, which is what
 * the Docker/CI story uses: a container has no home directory worth guessing at.
 */
export function minecraftDir({
  env = process.env, homedir = os.homedir, platform = process.platform,
} = {}) {
  if (env.MC_DIR) return path.resolve(env.MC_DIR);
  const home = path.resolve(homedir());
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'minecraft');
  return path.join(home, '.minecraft');
}

/**
 * The version jar (`versions/1.20.1/1.20.1.jar`), which is where the vanilla blockstates, models and
 * textures actually are. `VANILLA_JAR` wins outright so a non-default launcher layout is one variable
 * away rather than a code edit.
 */
export function vanillaJar(opts = {}) {
  const { env = process.env } = opts;
  if (env.VANILLA_JAR) return path.resolve(env.VANILLA_JAR);
  return path.join(minecraftDir(opts), 'versions', opts.version || MC_VERSION,
    `${opts.version || MC_VERSION}.jar`);
}

/** What to print when the jar is not there, so the fix is in the error, not in a search. */
export function vanillaJarHint(opts = {}) {
  return `vanilla jar not found at ${vanillaJar(opts)}
  point at one:  VANILLA_JAR=/path/to/${MC_VERSION}.jar ...
  or the whole install: MC_DIR=/path/to/.minecraft`;
}
