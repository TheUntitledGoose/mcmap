let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const i = s.indexOf('=> ');
  if (i < 0) { console.log('NO EVAL OUTPUT:\n' + s.slice(0, 400)); return; }
  const j = s.indexOf('{', i);
  let depth = 0, end = -1;
  for (let k = j; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
  }
  if (end < 0) { console.log('UNBALANCED:\n' + s.slice(i, i + 400)); return; }
  const o = JSON.parse(s.slice(j, end));
  console.log(`samples ${o.samples} ctxAA ${o.ctxAA} scale ${o.res.scale} | settle ${o.settle.fps} fps gpu ${o.settle.gpuMs} cpu ${o.settle.cpuMs} | orbit ${o.orbitFps} fps gpu ${o.orbitGpuMs} | verts ${o.settle.verts} draws ${o.settle.draws} | r${o.detailR}/${o.detailCeil} lod ${o.lodOn}/${o.lodTiles} dm ${o.detailMeshes} pill ${JSON.stringify(o.scaleShown)}`);
});
