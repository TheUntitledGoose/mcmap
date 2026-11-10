// Post-commit smoke: does the shipped page boot, arm the replay, and answer a pick with the log's verdict?
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
let t=0; while(!window.__world && t++<100) await sleep(200);
const w=window.__world, T=w.TLAYER;
const settle=async(ms)=>{const t0=performance.now();while(performance.now()-t0<ms){await new Promise(r=>requestAnimationFrame(r));w.tick(2);}};
await settle(6000);
const out={bootError:w.state.bootError||null, frames:w.state.frames, look:T.look, drawn:T.drawn,
  stacked:T.stacked, maxStack:T.maxStack, ramp:!!w.settings.timeStack,
  store:w.settingsStore(), playheadSec:w.time().sec, freshArm:T.freshArm};
w.setTimePlay(0); await settle(1500);
const p=w.pickWorld(Math.round(innerWidth/2), Math.round(innerHeight/2));
out.pick={block:p&&p.block, drawn:p&&p.drawn, stands:p&&p.stand&&p.stand.stands,
  arrival:p&&p.stand&&p.stand.arrival&&p.stand.arrival.sec};
out.hover=w.hoverAt(Math.round(innerWidth/2), Math.round(innerHeight/2)).visible;
out.why=(w.hover().why||'').slice(0,140);
await w.askAt(Math.round(innerWidth/2), Math.round(innerHeight/2)); await settle(1200);
const c=document.querySelector('.lcard');
out.card=c?c.textContent.replace(/\s+/g,' ').slice(0,200):'(no card)';
out.askWhy=w.ledger().askWhy;
console.log(JSON.stringify(out));
