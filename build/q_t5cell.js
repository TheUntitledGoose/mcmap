const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));const log=(o)=>console.log(JSON.stringify(o));
let t=0; while(!window.__world && t++<100) await sleep(200);
const w=window.__world, T=w.TLAYER;
await sleep(3000);
const P=w.LEDGER?.pack;
log({ hasPack: !!P, cellCount: P?.cellCount, bytes: w.LEDGER?.bytes,
  c7649: P?.cell?.(7649), c8122: P?.cell?.(8122), c0: P?.cell?.(0),
  tlCount: T?.tl?.count, tlFrom: w.LEDGER?.tlBytes });
