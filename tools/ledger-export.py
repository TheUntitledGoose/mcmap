#!/usr/bin/env python
"""M12: export the server's own block-history log (DarkRPG/world/ledger.sqlite, CoreProtect-shaped)
into the fixed-record binary that shared/ledger-format.mjs reads.

Why a separate exporter: the Node on this box is v18, which has no sqlite. The database is 92 MB of a
foreign format sitting *inside the irreplaceable world folder*, so it is opened read-only (mode=ro)
and never written - and everything downstream (packs, worldd endpoints, the browser) only ever sees
our own bytes.

Usage:  python tools/ledger-export.py [out.bin]     (default build/ledger/actions.bin)
"""
import calendar
import os
import sqlite3
import struct
import sys
from datetime import datetime

SRC = os.path.join('DarkRPG', 'world', 'ledger.sqlite')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join('build', 'ledger', 'actions.bin')

MAGIC = b'LGR1'
VERSION = 1
# Built by concatenation rather than by counting capital I's by eye: the assert is the thing that
# keeps this in step with RECORD_SIZE in shared/ledger-format.mjs.
REC = struct.Struct('<' + 'qq' + 'iii' + 'I' * 8 + 'B' + '3x')
assert REC.size == 64, REC.size
EXTRA_MAX = 256                          # free-form NBT payload: context for a card, not an archive
TIME_FORMATS = ('%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S',
                '%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S')


def to_ms(text):
    """The log stores wall-clock text with no zone; keep it as UTC epoch ms and print it back the
    same way, so a time shown in the viewer can be found verbatim in the database text."""
    if not text:
        return 0
    for fmt in TIME_FORMATS:
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return calendar.timegm(dt.utctimetuple()) * 1000 + int(round(dt.microsecond / 1000.0))
    raise SystemExit('ledger-export: unparseable time %r' % (text,))


def main():
    if not os.path.exists(SRC):
        raise SystemExit('ledger-export: no such file ' + SRC)
    con = sqlite3.connect('file:%s?mode=ro' % SRC.replace('\\', '/'), uri=True)
    q = lambda sql, *a: list(con.execute(sql, a))

    strings = ['']                       # index 0 means "absent", so a record can spell 0 for null
    sidx = {}

    def S(val):
        if val is None or val == '':
            return 0
        v = val if isinstance(val, str) else str(val)
        i = sidx.get(v)
        if i is None:
            i = len(strings)
            sidx[v] = i
            strings.append(v)
        return i

    worlds = [(r[0], S(r[1])) for r in q('select id, identifier from worlds order by id')]
    sources = [(r[0], S(r[1])) for r in q('select id, name from sources order by id')]
    actions = [(r[0], S(r[1])) for r in
               q('select id, action_identifier from ActionIdentifiers order by id')]
    objects = [(r[0], S(r[1])) for r in
               q('select id, identifier from ObjectIdentifiers order by id')]
    players = [(r[0], S(r[1]), to_ms(r[2]), to_ms(r[3])) for r in
               q('select id, player_name, first_join, last_join from players order by id')]

    rows = q('''select rowid, time, x, y, z, world_id, action_id, object_id, old_object_id,
                       source, player_id, block_state, extra_data, rolled_back
                from actions order by rowid''')
    con.close()

    # Intern every string - including the per-row block_state / extra_data text - *before* the string
    # table is written. The first version of this wrote the table before the row loop interned those,
    # and every record then carried an id into a table that did not contain it.
    for row in rows:
        S(row[11])                       # block_state text
        extra = row[12]
        S(extra[:EXTRA_MAX] if extra is not None and len(extra) > EXTRA_MAX else extra)

    out = bytearray()
    out += MAGIC
    out += struct.pack('<I', VERSION)
    nStrWritten = len(strings)
    out += struct.pack('<I', nStrWritten)
    for s in strings:
        b = s.encode('utf-8')
        out += struct.pack('<I', len(b)) + b

    def table(entries, fmt):
        out.extend(struct.pack('<I', len(entries)))
        for e in entries:
            out.extend(struct.pack(fmt, *e))

    table(worlds, '<II')
    table(sources, '<II')
    table(actions, '<II')
    table(objects, '<II')
    table(players, '<IIqq')

    out += struct.pack('<I', len(rows))
    for (rid, t, x, y, z, wid, aid, oid, ooid, src, pid, bstate, extra, rb) in rows:
        if extra is not None and len(extra) > EXTRA_MAX:
            extra = extra[:EXTRA_MAX]
        out += REC.pack(rid, to_ms(t), x, y, z, wid or 0, aid or 0, oid or 0, ooid or 0,
                        src or 0, pid or 0, S(bstate), S(extra), 1 if rb else 0)

    os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
    if len(strings) != nStrWritten:
        raise SystemExit('ledger-export: %d strings interned after the table was written - every '
                         'string a record points at must be interned first'
                         % (len(strings) - nStrWritten))
    tmp = OUT + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(out)
    os.replace(tmp, OUT)
    print('ledger-export: %d actions, %d worlds, %d sources, %d objects, %d players, %d strings'
          % (len(rows), len(worlds), len(sources), len(objects), len(players), len(strings)))
    print('ledger-export: wrote %s (%.1f MB)' % (OUT, len(out) / 1048576.0))


main()
