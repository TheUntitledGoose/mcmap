await new Promise((r)=>setTimeout(r,1500));
const t=window.__world.time();
return { base: t.base, span: t.span, sec: t.sec, quads: t.quads, tl: t.tl };
