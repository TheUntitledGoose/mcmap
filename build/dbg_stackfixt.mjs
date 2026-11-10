import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { fakeLog } from '../tests/fake-ledger.mjs';
const T=(s)=>1717174690000+s*1000;
const json=JSON.parse(fs.readFileSync('build/assets/atlas.json','utf8'));
const g=fs.readFileSync('build/assets/geometry.bin');
const assets=new Assets(json,g.buffer.slice(g.byteOffset,g.byteOffset+g.byteLength));
function run(rows,label){
  const L=fakeLog(rows.map(([x,y,z,aid,name,old,sec])=>[1,x,y,z,aid,1,T(sec),name,old]));
  const {buf}=buildPack(L,1,'region',{heightOf:()=>64});
  const P=readPack(buf); const tl=decodeTimeline(buf.subarray(P.tlBytes[0],P.tlBytes[1]));
  resetMarkerLift();
  const b=buildTimeBlocks(tl,P,Array.from({length:tl.count},(_,i)=>i),assets,stateIdsByName(assets.states),{grow:1.18,stackGrow:0.36});
  const names=[]; for(let i=0;i<tl.count;i++) names.push([tl.action[i],tl.nameOf(i),tl.was?.[i]]);
  console.log(label,'rows',tl.count,'stats',JSON.stringify(b.stats));
  console.log('  first rows',JSON.stringify(names.slice(0,4)));
}
const two=[[2,64,3,2,'minecraft:stone','minecraft:air',10],[2,64,3,3,'minecraft:air','minecraft:stone',30]];
run(two,'two');
const many=[]; for(let i=0;i<6;i++) many.push([7,64,7,i%2?2:3,i%2?'minecraft:air':'minecraft:stone',i%2?'minecraft:stone':'minecraft:air',100+i]);
run(many,'many');
