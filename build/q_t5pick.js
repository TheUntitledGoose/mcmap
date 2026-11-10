// Does the outline and the click answer the PLAYHEAD, or today's mesh? Terrain undo is off in this URL,
// so the ground on screen is today's ground while the playhead sits at the first logged second: the
// blocks under the cursor are blocks that do not exist yet.
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));const log=(o)=>console.log(JSON.stringify(o));
let t=0; while(!window.__world && t++<100) await sleep(200);
const w=window.__world,T=w.TLAYER;
const settle=async(ms)=>{const t0=performance.now();while(performance.now()-t0<ms){await new Promise(r=>requestAnimationFrame(r));w.tick(2);}};
const txt=()=>{const c=document.querySelector('.lcard');const m=document.querySelector('#msg');
  return {card:c?c.textContent.replace(/\s+/g,' ').slice(0,240):'(no card)',msg:m?m.textContent.replace(/\s+/g,' ').slice(0,240):'(no msg)'};};
await settle(4000);
const out={settings:{time:w.settings.time,terrain:w.settings.timeTerrain,pick:w.settings.timePick,
  look:T.look,hover:w.settings.hover}};
w.setTimePlay(0);
w.timeSeekRow(0); await settle(600);
out.early={drawn:T.drawn,quads:T.quads,rows:T.rows,playheadSec:w.time().sec,terrainOn:w.hist().on};
// A coarse sweep of rays finds a pixel whose drawn block the log says is NOT standing at this second.
// One pickWorld is ~10 ms, so this costs a few seconds once, and it searches the real scene graph.
const cx0=Math.round(innerWidth/2)-160, cy0=Math.round(innerHeight/2)-120;
let found=null, swept=0, refused0=0, unknown0=0, standing0=0;
for(let yy=cy0; yy<cy0+240 && !found; yy+=24) for(let xx=cx0; xx<cx0+320 && !found; xx+=24){
  const p=w.pickWorld(xx,yy); swept++;
  if(!p||!p.block) continue;
  const s=p.stand?p.stand.stands:'no-timeline';
  if(s===0){refused0++;found={pixel:[xx,yy],p};} else if(s===null) unknown0++; else standing0++;
}
out.sweep={swept,refused:refused0,unknown:unknown0,standing:standing0};
if(found){
  const [px,py]=found.pixel, p=found.p;
  out.refusal={pixel:[px,py],block:p.block,from:p.drawn,name:p.name,
    stand:p.stand.stands,rowsForVoxel:p.stand.n,
    firstClaim:p.stand.starts?{action:p.stand.starts.cls,sec:p.stand.starts.sec}:null,
    why:p.stand.starts?`the log's first claim is action ${p.stand.starts.cls} at second ${p.stand.starts.sec}`:'no earlier row'};
  w.hoverReset();
  const hv=w.hoverAt(px,py);
  out.refusal.hover={at:hv.at,visible:hv.visible,changes:hv.changes,ms:hv.ms};
  out.refusal.hoverDiag=(()=>{const h=w.hover();return {at:h.at,stand:h.stand,refused:h.refused,
    why:(h.why||'').slice(0,190)};})();
  await w.askAt(px,py); await sleep(600);
  out.refusal.click={why:w.ledger().askWhy,card:txt(),asks:w.ledger().asks,lastAsk:w.ledger().lastAsk??null};
  // A/B the same pixel with the playhead verdict switched off.
  w.settings.timePick=0;
  const p0=w.pickWorld(px,py), h0=w.hoverAt(px,py);
  out.refusal.pickOff={stand:p0?.stand===undefined?'not consulted':p0?.stand?.stands,
    hoverVisible:h0.visible,hoverWhy:(w.hover().why||'').slice(0,80)};
  await w.askAt(px,py); await sleep(600);
  out.refusal.clickOff={why:w.ledger().askWhy,card:txt(),lastAsk:w.ledger().lastAsk??null};
  w.settings.timePick=1;
}
// idle costs nothing (put the cursor down first, or the skip reason is "no cursor", not "nothing moved")
w.hoverAt(Math.round(innerWidth/2),Math.round(innerHeight/2));
w.hoverReset(); await settle(3000);
out.idle={passes:w.hover().passes,skips:w.hover().skips,why:w.hover().why};
// what the answers cost, with every marker drawn
w.timeSeekRow(T.rows-1); await settle(3000);
let t0=performance.now(); for(let k=0;k<200;k++) w.timeDrawnAt(-59,72,-130); const cheap=+(performance.now()-t0).toFixed(3);
t0=performance.now(); const hit=w.timeHitAt(Math.round(innerWidth/2),Math.round(innerHeight/2));
const ray=+(performance.now()-t0).toFixed(1);
out.cost={drawn:T.drawn,timeDrawnAt200xMs:cheap,perLookup:+(cheap/200).toFixed(5),markerRayMs:ray,
  rayHit:hit?hit.voxel:null};
// and the same pixel now that the playhead is at the end: the block stands, the outline stands
const p2=w.pickWorld(Math.round(innerWidth/2),Math.round(innerHeight/2));
w.hoverAt(Math.round(innerWidth/2),Math.round(innerHeight/2));
out.atEnd={block:p2?.block,stand:p2?.stand?.stands,hoverVisible:w.hoverAt(Math.round(innerWidth/2),Math.round(innerHeight/2)).visible,
  hoverStand:w.hover().stand};
log(out);
