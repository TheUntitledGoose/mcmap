(() => {
  const sleep = (ms) => new Promise((x) => { setTimeout(x, ms); });
  return (async () => {
    __world.go(2976, 68, 2007);
    __world.orbit(0.6, 0.22, 150);
    await sleep(9000); __world.tick(200);
    const q = __world.state;
    const row = [];
    row.push(JSON.stringify({ dist: Math.round(q.dist), verts: q.verts, detailVerts: q.detailVerts,
      detailR: q.detailRadius, dMesh: q.detailMeshes, shellVerts: q.shellVerts, ovCells: q.ovCells,
      ovSkipped: q.ovSkipped, held: q.chunks, shellHeld: q.shellHeld, missing: q.missing,
      shellMissing: q.shellMissing, skinR: q.skinRadius, render: __world.renderMs(), err: q.frameError }));
    for (const [dx, dz] of [[0,0], [8,0], [-8,0], [0,8], [0,-8]]) {
      const l = __world.lodOf(2976 + dx, 2007 + dz), o = __world.ovAt(2976 + dx, 2007 + dz);
      row.push(`@${dx},${dz} cell=${l.cell} tier=${l.tier} detail=${l.detail} shell=${l.shell} payload=${l.payload} ovh=${o.h} ovState=${o.state} covered=${o.covered}`);
    }
    for (const y of [[400,300],[640,400],[900,420],[640,600]]) {
      const cp = __world.camera.position;
      const d = (pt) => Math.round(Math.hypot(pt.x - cp.x, pt.y - cp.y, pt.z - cp.z));
      const st = __world.pickStack(y[0], y[1], 4).map((h) => `${h.drawn}@${d(h.point)}m ${h.state || h.shellState || '-'} y=${Math.round(h.point.y)}`);
      row.push(`hit[${y}] ${st.join(' | ') || 'SKY'}`);
    }
    return row.join('\n');
  })();
})()
