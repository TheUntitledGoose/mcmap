(() => {
  const q = __world.state;
  return `fps=${Math.round(q.fps)} dist=${Math.round(q.dist)} detailR=${q.detailRadius}` +
    ` detailVerts=${q.detailVerts} shellVerts=${q.shellVerts} total=${q.verts} loop=${q.loopFrames}` +
    ` err=${q.frameError}`;
})()
