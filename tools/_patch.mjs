import fs from 'node:fs';

let p = 'web/js/shell-mesh.js', s = fs.readFileSync(p, 'utf8');
s = s.replace(
  'any = any || { cell, code: 0 };\n        if (dir >= 0 && !per[dir]) per[dir] = { cell, code: 0 };',
  'any = any || { cell, code: null };\n        if (dir >= 0 && !per[dir]) per[dir] = { cell, code: null };');
s = s.replace('const [su, sv] = spr.code ? cubeFaceUV(spr.code, i) : PLAIN_UV[i];',
  'const [su, sv] = spr.code === null ? PLAIN_UV[i] : cubeFaceUV(spr.code, i);');
fs.writeFileSync(p, s);

p = 'web/js/assets.js'; s = fs.readFileSync(p, 'utf8');
const old = [
  '    // per-state classification used for face culling and pass bucketing',
  '    this.stateOpaque = new Uint8Array(this.states.length);',
  '    this.stateAir = new Uint8Array(this.states.length);',
  '    this.stateCube = new Uint8Array(this.states.length);',
  '    for (let i = 0; i < this.states.length; i++) {',
  '      const s = this.states[i];',
  '      if (s.r === 3) { this.stateAir[i] = 1; continue; }',
  '      if (s.cube) {',
  '        this.stateCube[i] = 1;',
  '        let opaque = true;',
  '        for (const code of s.cube[0]) {',
  '          const t = this.textures[decodeFaceCode(code)[0]];',
  '          if (!t || t.kind !== 0) opaque = false;',
  '        }',
  '        this.stateOpaque[i] = opaque ? 1 : 0;',
  '      }',
  '    }',
].join('\n');
const neu = [
  '    // Per-state classification used for face culling and pass bucketing. Shared with worldd so',
  "  // \"is this state a full cube\" means one thing on both sides of the wire.",
  '    const cls = classifyStates(this.states, this.textures);',
  '    this.stateAir = cls.air;',
  '    this.stateCube = cls.cube;',
  '    this.stateOpaque = cls.opaque;',
].join('\n');
if (!s.includes(old)) throw new Error('assets.js classification block not found');
s = s.replace(old, neu);
const imp = "import { decodeFaceCode } from '../../shared/cube-path.mjs';";
if (!s.includes(imp)) throw new Error('assets.js import line not found');
s = s.replace(imp, "import { decodeFaceCode, classifyStates } from '../../shared/cube-path.mjs';");
fs.writeFileSync(p, s);
console.log('patched');
