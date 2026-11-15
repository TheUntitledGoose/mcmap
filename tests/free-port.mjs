// A port to run a test server on, asked of the OS instead of guessed.
//
// The suites used to each take a slice of 8790-8990 (`8790 + pid % 90`, `8880 + pid % 90`, ...). Those
// slices overlap - the skins suite's 8880-8969 and the worlds suite's 8900-8989 have 70 ports in common -
// so whichever two files happened to land on the same one produced a server that never came up and a test
// that passes alone and fails in a full run. Reading that failure as a bug in the server is a bad hour.
//
// A port from the OS (bind 0, read it back, close, hand it to the child) cannot collide with another
// suite. There is still a window between closing and the child binding; it is milliseconds wide, and a
// failure there says "EADDRINUSE" in the child's log rather than looking like a routing bug.
import net from 'node:net';

export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, host, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
