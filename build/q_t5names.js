// Before the pick is allowed to compare names, measure whether the log's block name and the chunk's block
// name are the SAME STRING for the same voxel. A namespace or property mismatch here would turn a
// playhead verdict into "that block is not there" everywhere, i.e. an outline that never shows.
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));const log=(o)=>console.log(JSON.stringify(o));
let t=0; while(!window.__world && t++<100) await sleep(200);
const w=window.__world,T=w.TLAYER;
const settle=async(ms)=>{const t0=performance.now();while(performance.now()-t0<ms){await new Promise(r=>requestAnimationFrame(r));w.tick(2);}};
await settle(4000); w.setTimePlay(0); w.timeSeekRow(T.rows-1); await settle(4000);
const plain=(k)=>(k?String(k).split('|')[0]:null);
const ACT=['change','place','break','c-insert','c-remove','kill','other'];
const tally={sampled:0,noPayload:0,noLogName:0,agree:0,differ:0,byAct:{},diffSample:[]};
const step=Math.max(1,Math.floor(T.drawn/3000));
for(let item=0;item<T.drawn;item+=step){
  const row=T.quadRow[item]; if(row==null||row<0) continue;
  const wd=w.timeRowWorld(row); if(!wd) continue;
  const [x,y,z]=wd; const lk=plain(w.at(x,y,z)); const nm=T.tl.nameOf(row); const act=ACT[T.tl.action[row]];
  tally.sampled++;
  if(!nm){tally.noLogName++;continue;}
  if(!lk){tally.noPayload++;continue;}
  if(nm===lk) tally.agree++; else {
    tally.differ++;
    if(tally.diffSample.length<12) tally.diffSample.push({act,voxel:[x,y,z],log:nm,payload:lk});
  }
  const b=tally.byAct[act]||(tally.byAct[act]={agree:0,differ:0,noPayload:0,noLogName:0});
  b[nm===lk?'agree':(!nm?'noLogName':(!lk?'noPayload':'differ'))]++;
}
log({drawn:T.drawn,tally});
