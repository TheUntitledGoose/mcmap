// Where does a pan actually spend its time? Report the per-frame CPU buckets while dragging.
const w = window.__world, out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [sx, , sz] = w.state.target;
out.push("settled " + JSON.stringify(w.prof()));
for (let i = 0; i < 10; i++) { w.go(sx + i * 40, 110, sz + i * 18); await sleep(260); }
out.push("drag    " + JSON.stringify(w.prof()));
out.push("state   " + JSON.stringify({ fps: +w.state.fps.toFixed(1), verts: w.state.verts, detail: w.state.detailMeshes, patches: w.gridEst().patches, dirty: w.gridEst().dirty, cuts: w.gridEst().cuts, cutMs: +w.gridEst().cutMs.toFixed(1), meshMs: w.state.meshMs }));
return out.join("\n");
