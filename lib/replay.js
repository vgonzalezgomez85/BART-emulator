'use strict';

// ============================================================================
//  Parser de capturas DS-300 (RegistroCarrera.txt) → timeline de cruces.
//  Formato por línea:  HH:MM:SS.mmmm  E0 .. EB   (21 bytes; byte[10] = carriles)
//  El carril va en el byte índice 10 como bitmask (mismo LANE_MAP que SlotTime).
//  Sirve para que el emulador reproduzca una carrera REAL como vueltas BART.
// ============================================================================

const fs = require('fs');

const LANE_MAP = [
  [0x80, 1], [0x40, 2], [0x20, 3], [0x10, 4],
  [0x08, 5], [0x04, 6], [0x02, 7], [0x01, 8],
];

// Devuelve { events: [{atMs, lane}], lanes } con atMs relativo al primer cruce.
function parseCapture(path) {
  let content;
  try { content = fs.readFileSync(path, 'utf8'); }
  catch (e) { return { events: [], lanes: 0, error: e.message }; }

  const lineRe = /^(\d+):(\d+):(\d+)\.(\d+)\s+((?:[0-9A-Fa-f]{2}\s*)+)/;
  let prevRawMs = -1, offset = 0;
  const raw = [];

  for (const line of content.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const bytes = m[5].trim().split(/\s+/).map(h => parseInt(h, 16));
    if (bytes.length < 11) continue;
    const laneByte = bytes[10];
    if (!laneByte) continue;

    const lanes = [];
    for (const [mask, lane] of LANE_MAP) if (laneByte & mask) lanes.push(lane);
    if (!lanes.length) continue;

    const frac4 = m[4].padEnd(4, '0').slice(0, 4);
    const rawMs = (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+frac4) * 0.1;
    if (prevRawMs >= 0 && rawMs < prevRawMs - 3600000) offset += 86400000; // wrap medianoche
    prevRawMs = rawMs;

    const absMs = rawMs + offset;
    for (const lane of lanes) raw.push({ absMs, lane });
  }

  raw.sort((a, b) => a.absMs - b.absMs);
  if (!raw.length) return { events: [], lanes: 0 };

  const t0 = raw[0].absMs;
  const events = raw.map(e => ({ atMs: Math.round(e.absMs - t0), lane: e.lane }));
  const lanes = Math.max(...events.map(e => e.lane));
  return { events, lanes };
}

module.exports = { parseCapture, LANE_MAP };
