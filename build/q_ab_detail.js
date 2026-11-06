// Does a full-resolution chunk ever get covered by a coarse cell? Same framing, two settings, pixels.
async function s(w, ms = 1200) { w.tick(4); await new Promise((r) => setTimeout(r, ms)); }
const w = __world, out = [];
w.go(0, 112, 0, 0, 12, 200); await s(w, 3000);
out.push(`href ${location.search}`);
out.push(`lod ${JSON.stringify(w.lodDiag())}`);
out.push(`grid ${JSON.stringify(w.gridEst())}`);
out.push(`detail ${JSON.stringify(w.state.detail)} patches ${w.state.patches}`);
return out.join("\n");
