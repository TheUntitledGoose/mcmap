(async () => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const out = [];
  __world.orbit(0.6, 0.45, 1500); await sleep(11000); __world.tick(150);
  out.push(`1500: shell=${__world.state.shellVerts} detail=${__world.state.detailVerts} boost=${__world.gridEst().floorBoost}`);
  window.__shot = 1500;
  return out.join('\n');
})()
