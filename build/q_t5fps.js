// Frame cost of the stack ramp, measured over a window rather than one instantaneous read.
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));const log=(o)=>console.log(JSON.stringify(o));
let t=0; while(!window.__world && t++<100) await sleep(200);
const w=window.__world,T=w.TLAYER;
const settle=async(ms)=>{const t0=performance.now();while(performance.now()-t0<ms){await new Promise(r=>requestAnimationFrame(r));w.tick(2);}};
await settle(6000); w.setTimePlay(0);
w.timeSeekRow(T.rows-1);           // playhead at the end: every marker drawn
await settle(6000);
const frames=async(ms)=>{let n=0;const t0=performance.now();while(performance.now()-t0<ms){await new Promise(r=>requestAnimationFrame(r));w.tick(2);n++;}return +(1000*ms/(performance.now()-t0)).toFixed(1);};
const samples=[]; for(let k=0;k<3;k++){ samples.push({smoothedFps:+w.state.fps.toFixed(1), measuredFps: await frames(2000)}); }
log({ look:T.look, drawn:T.drawn, quads:T.quads, verts:T.verts, markerGeoMb:w.time().markerGeoMb,
  gpuMB:w.state.gpuMB??null, stacked:w.time().stacked, maxStack:w.time().maxStack, ramp:w.time().stackRamp,
  detailChunks:w.state.chunks, samples });
