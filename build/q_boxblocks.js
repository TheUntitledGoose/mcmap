(() => {
  const w = window.__world, out = [];
  for (const [x, y] of [[760, 200], [700, 235], [700, 305], [880, 340]]) {
    const h = w.pickStack(x, y, 1)[0];
    out.push(h ? `${x},${y} drawn=${h.drawn} block=${h.block.join(',')} tile=${h.lodTile || '-'}` : `${x},${y} none`);
  }
  return out.join('\n');
})()
