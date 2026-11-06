(() => {
  const sleep = (ms) => new Promise((x) => { setTimeout(x, ms); });
  return (async () => {
    __world.go(2976, 68, 2007); __world.orbit(0.6, 0.22, 150);
    await sleep(9000); __world.tick(200);
    const out = [];
    for (const [x, y] of [[620, 410], [250, 180], [1160, 470], [760, 620]]) {
      const st = __world.pickStack(x, y, 5).map((h) => {
        const p = h.point;
        return `${h.drawn} ${h.quad} at(${p[0]},${p[1]},${p[2]}) blk(${h.block}) voxel=${h.state} painted=${h.shellState} op=${h.op}`;
      });
      out.push(`screen[${x},${y}]\n  ` + (st.join('\n  ') || 'SKY'));
    }
    for (let k = -4; k <= 4; k++) {
      const o = __world.ovAt(2976 + k * 64, 2007);
      const sh = __world.shellAt(Math.floor((2976 + k * 64) / 16), Math.floor(2007 / 16));
      let top = null;
      if (sh) { top = -999; for (let i = 0; i < 256; i++) top = Math.max(top, sh.height[i] - 2048); }
      out.push(`ov k=${k} x=${2976 + k * 64} h=${o.h} state=${o.state} covered=${o.covered} shellMaxTop=${top}`);
    }
    out.push(JSON.stringify(__world.ovDiag()));
    return out.join('\n');
  })();
})()
