const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));const log=(o)=>console.log(JSON.stringify(o));
let t=0; while(!window.__world && t++<100) await sleep(200);
const w=window.__world, T=w.TLAYER;
const settle=async(ms)=>{const t0=performance.now();while(performance.now()-t0<ms){await new Promise(r=>requestAnimationFrame(r));w.tick(2);}};
await settle(4000); w.setTimePlay(0);
if(!T.tl){log({err:'no tl'});return;}
let lo=0,hi=T.rows; while(lo<hi){const m=(lo+hi)>>1; if(T.quadSec[m]>=356000) hi=m; else lo=m+1;}
w.timeSeekRow(lo); await settle(3000);
const tl=T.tl;
const keyOf=(row)=>tl.cellOf(row)*2097152+((tl.y(row)+4096)<<8)+((tl.z(row)&15)<<4)+(tl.x(row)&15);
// find drawn rows whose name is sand and sec is 94005/94006, and report everything about them
const found=[];
for(let item=0;item<T.drawn && found.length<6;item++){
  const row=T.quadRow[item]; if(row<0) continue;
  if((tl.sec[row]===94005||tl.sec[row]===94006)&&tl.nameOf(row)==='minecraft:sand'){
    found.push({item,row,cell:tl.cellOf(row),x:tl.x(row),y:tl.y(row),z:tl.z(row),
      key:keyOf(row),world:w.timeRowWorld(row),name:tl.nameOf(row),act:tl.action[row],sec:tl.sec[row]});
  }
}
// and the same for the stone row 25317 if drawn
const stoneIdx=T.quadRow.indexOf(25317);
log({sandRows:found, stoneItem:stoneIdx,
  stoneWorld: stoneIdx>=0? w.timeRowWorld(25317):null,
  stoneKey: stoneIdx>=0? keyOf(25317):null,
  cellOfStone: tl.cellOf(25317), xyzStone:[tl.x(25317),tl.y(25317),tl.z(25317)]});
