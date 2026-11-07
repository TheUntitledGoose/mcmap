await new Promise((r) => requestAnimationFrame(r));
return { keys: Object.keys(window.__world).sort().join(' '), typeofState: typeof window.__world.state };
