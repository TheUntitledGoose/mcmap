const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);
console.log(JSON.stringify({ keys: Object.keys(w).sort() }));
