// M12 census: read build/ledger/actions.bin back through our own reader and check it against what
// sqlite said. Two independent readers agreeing on the same row is the only cheap proof that the
// Python writer and the JS reader describe the same bytes.
//
//   node build/dbg-ledger.mjs
import { readFileSync } from 'node:fs';
import { ACTION_NAME, formatLedgerTime, readLedger } from '../shared/ledger-format.mjs';

const L = readLedger(readFileSync('build/ledger/actions.bin'));
const tally = (fn) => {
  const m = new Map();
  for (let i = 0; i < L.count; i++) {
    const k = fn(i);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('records', L.count);
console.log('worlds', [...L.worlds].map(([id, w]) => `${id}:${w.id}`).join(' '));
console.log('players', [...L.players].map(([id, p]) => `${id}:${p.name}`).join(' '));
console.log('action table', [...L.actions].map(([id, a]) => `${id}:${a.id}`).join(' '));

console.log('by action:', tally((i) => ACTION_NAME[L.actionId(i)] ?? L.actionId(i))
  .map(([k, n]) => `${k} ${n}`).join(', '));
console.log('by world:', tally((i) => L.worlds.get(L.worldId(i))?.id ?? L.worldId(i))
  .map(([k, n]) => `${k} ${n}`).join(', '));
console.log('player-attributed', tally((i) => (L.playerId(i) ? 'yes' : 'no')).map(([k, n]) => `${k} ${n}`).join(', '));
console.log('rolled back', tally((i) => L.rolledBack(i)).map(([k, n]) => `${k} ${n}`).join(', '));

let t0 = Infinity, t1 = -Infinity, rowsOut = 0;
for (let i = 0; i < L.count; i++) {
  const t = L.timeMs(i);
  if (t < t0) t0 = t;
  if (t > t1) t1 = t;
  if (!L.worlds.has(L.worldId(i)) || !L.objects.has(L.objectId(i))) rowsOut++;
}
console.log('time range', formatLedgerTime(t0), '->', formatLedgerTime(t1));
console.log('rows with a dangling world/object id', rowsOut);

const top = (aid, n = 12) => tally((i) => (L.actionId(i) === aid && L.playerId(i)
  ? `${L.players.get(L.playerId(i))?.name}|${L.objects.get(L.objectId(i))?.id}` : null))
  .slice(0, n);
console.log('player places (top):', top(1).map(([k, v]) => `${v} ${k}`).join(', '));
console.log('player breaks (top):', top(2).map(([k, v]) => `${v} ${k}`).join(', '));
console.log('player uses (top):', top(3).map(([k, v]) => `${v} ${k}`).join(', '));

// Per-chunk fan-out: this is the shape a per-chunk bucket index has to serve.
for (const wid of [1, 5, 4, 2]) {
  const chunks = new Map();
  for (let i = 0; i < L.count; i++) {
    if (L.worldId(i) !== wid || !L.playerId(i)) continue;
    const k = (L.x(i) >> 4) + ',' + (L.z(i) >> 4);
    chunks.set(k, (chunks.get(k) ?? 0) + 1);
  }
  const vals = [...chunks.values()].sort((a, b) => b - a);
  const dim = L.worlds.get(wid)?.id;
  console.log(`dim ${dim}: player actions ${vals.reduce((a, b) => a + b, 0)} across ${vals.length} ` +
    `chunks; hottest ${vals[0]} at ${[...chunks].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => `${k}=${n}`).join(' ')}`);
}
