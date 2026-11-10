const w = window.__world;
console.log(JSON.stringify({
  tkeys: Object.keys(w.TLAYER).filter((k) => !/^(mesh|geo|mat)$/.test(k)),
  pos: w.TLAYER.pos && w.TLAYER.pos.length,
  markerEnd: w.TLAYER.markerEnd && w.TLAYER.markerEnd.length,
  mCx: w.TLAYER.mCx && w.TLAYER.mCx.length,
  look: w.TLAYER.look, drawn: w.TLAYER.drawn, quads: w.TLAYER.quads,
  split: w.timeSplit ? w.timeSplit() : 'no timeSplit',
  grow: w.settings.timeGrow, sharp: w.settings.timeSharp,
  detailRadius: w.state.detailRadius,
}));
