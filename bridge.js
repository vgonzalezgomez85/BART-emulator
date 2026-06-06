'use strict';

// ============================================================================
//  BART bridge  —  the BART-side "phone" for SlotTime.
//
//  Connects to a BART Master, enables notifications, decodes the binary stream
//  and emits ONE clean JSON line per lap crossing. SlotTime never sees a byte
//  of BART binary: this process does all the A5/CRC-8 work and hands over
//  normalized crossings (the same idea InfolapServer already uses).
//
//  Transports (pluggable — the hard BLE part is isolated here):
//    --transport tcp   connect to the Node emulator over TCP   (default, no BLE)
//    --transport ble   connect to a real BART_MST over BLE     (TODO: noble)
//
//  Output:
//    stdout            one JSON object per line (default; great for piping)
//    --udp host:port   also send each JSON crossing as a UDP datagram
//
//  Examples:
//    node bridge.js                                   # tcp -> stdout
//    node bridge.js --udp 127.0.0.1:5300              # tcp -> stdout + UDP
//    node bridge.js --circuit 1 --lane-offset 4       # 2nd Master, lanes 5..8
//    node bridge.js --drop-rate 0.08                  # simulate 8% BLE loss
// ============================================================================

const net   = require('net');
const dgram = require('dgram');
const P     = require('./lib/protocol');

const WIRE_VERSION = 1;

// ── CLI / env ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    transport:  'tcp',
    host:       process.env.BART_HOST || '127.0.0.1',
    port:       Number(process.env.BART_PORT || 9300),
    circuit:    0,
    laneOffset: 0,
    minlap:     null,        // null = don't send SET_MINLAP, leave Master default
    start:      false,       // send a one-shot START after connecting
    udp:        null,        // { host, port }
    dropRate:   0,           // 0..1 — drop this fraction of RX frames (loss demo)
    quiet:      false,       // suppress non-crossing logs on stderr
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    switch (a) {
      case '--transport':  o.transport  = next(); break;
      case '--host':       o.host       = next(); break;
      case '--port':       o.port       = Number(next()); break;
      case '--circuit':    o.circuit    = Number(next()); break;
      case '--lane-offset':o.laneOffset = Number(next()); break;
      case '--minlap':     o.minlap     = Number(next()); break;
      case '--start':      o.start      = true; break;
      case '--drop-rate':  o.dropRate   = Number(next()); break;
      case '--quiet':      o.quiet      = true; break;
      case '--udp': {
        const [h, p] = next().split(':');
        o.udp = { host: h, port: Number(p) };
        break;
      }
      default:
        if (a.startsWith('--')) { console.error(`[bridge] unknown flag ${a}`); process.exit(2); }
    }
  }
  return o;
}

const opts = parseArgs(process.argv);

// ── output sinks ──────────────────────────────────────────────────────────
const udpSock = opts.udp ? dgram.createSocket('udp4') : null;

function emitCrossing(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(line + '\n');                       // canonical output
  if (udpSock) udpSock.send(line, opts.udp.port, opts.udp.host);
}

function log(...a)  { if (!opts.quiet) console.error('[bridge]', ...a); }
function warn(...a) { console.error('[bridge]', ...a); }

// ── per-lane state for gap detection ────────────────────────────────────────
// The cumulative `laps` counter in every LAP packet lets us notice dropped
// crossings: if we saw lap 5 and the next is lap 7, lap 6 was lost in transit.
// This is exactly what the gap-less, time-framed DS-300 stream cannot do.
const lastLapByLane = new Map();

function onLapFrame(frame) {
  const lane   = frame[3];
  const laps   = frame.readUInt16LE(4);
  const lapMs  = frame.readUInt16LE(6);
  const tsD10  = frame.readUInt16LE(8);
  const recvMs = Date.now();                               // OUR clock is the truth

  const globalLane = lane + opts.laneOffset;

  // gap detection (handles uint16 wrap of the counter, ~65535 laps)
  let missed = 0;
  const prev = lastLapByLane.get(lane);
  if (prev != null) {
    const delta = (laps - prev + 0x10000) & 0xFFFF;
    if (delta > 1) missed = delta - 1;
  }
  lastLapByLane.set(lane, laps);

  if (missed > 0) warn(`gap on lane ${globalLane}: ${missed} lap(s) lost (prev=${prev}, now=${laps})`);

  emitCrossing({
    v:       WIRE_VERSION,
    type:    'lap',
    circuit: opts.circuit,
    lane:    globalLane,
    laps,
    lap_ms:  lapMs,
    ts_d10:  tsD10,
    recv_ms: recvMs,
    gap:     missed,
  });
}

function onStatusFrame(frame) {
  const state  = frame[3];
  const minlap = frame.readUInt16LE(4);
  const lanes  = frame[8];
  log(`STATUS state=${P.STATE_NAME[state] || state} minlap=${minlap} lanes=${lanes}`);
}

function onAckFrame(frame) {
  log(`ACK op=0x${frame[2].toString(16).padStart(2, '0')} result=0x${frame[3].toString(16).padStart(2, '0')}`);
}

// ── transport abstraction ────────────────────────────────────────────────
// A transport is anything that gives us a byte stream both ways. Today: TCP to
// the emulator. Later: a BLE transport (noble) writing the NUS RX char and
// notifying on TX — same onData()/write() shape, nothing else changes.
function makeTcpTransport(handlers) {
  let sock = null;
  let backoff = 500;
  const MAX_BACKOFF = 8000;
  let reconnectTimer = null;

  function connect() {
    sock = net.connect(opts.port, opts.host);
    sock.on('connect', () => {
      backoff = 500;
      log(`connected to BART (tcp ${opts.host}:${opts.port})`);
      handlers.onOpen(buf => { if (sock && !sock.destroyed) sock.write(buf); });
    });
    sock.on('data', handlers.onData);
    sock.on('close', () => { log('transport closed'); scheduleReconnect(); });
    sock.on('error', e => { log(`transport error: ${e.message}`); });
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    handlers.onClose();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log(`reconnecting…`);
      connect();
    }, backoff);
    backoff = Math.min(MAX_BACKOFF, backoff * 2);
  }
  connect();
}

// ── wire it together ────────────────────────────────────────────────────────
// Decoder: resync-capable parser; on the bridge side every inbound frame is a
// Master->Phone notification (LAP / STATUS / ACK).
const parser = new P.FrameParser(
  (msgType /*, op */) => P.notifyLength(msgType),
  ({ msgType, frame }) => {
    if (opts.dropRate > 0 && msgType === P.MSG.LAP && Math.random() < opts.dropRate) {
      warn(`(dropped one LAP frame to simulate BLE loss)`);
      return;                                              // pretend it never arrived
    }
    if      (msgType === P.MSG.LAP)    onLapFrame(frame);
    else if (msgType === P.MSG.STATUS) onStatusFrame(frame);
    else if (msgType === P.MSG.ACK)    onAckFrame(frame);
  },
  err => warn(`frame ${err.type}${err.frame ? ' [' + P.hex(err.frame) + ']' : ''}`),
);

function startTransport() {
  if (opts.transport === 'tcp') {
    makeTcpTransport({
      onOpen: (write) => {
        // 1) enable notifications (7.1)
        write(P.seal([P.SYNC, P.MSG.CMD, P.OP.NOTIFY, 0x01]));
        // 2) optionally push our MinLap config
        if (opts.minlap != null) {
          const ml = Buffer.alloc(5);
          ml[0] = P.SYNC; ml[1] = P.MSG.CMD; ml[2] = P.OP.SET_MINLAP; ml.writeUInt16LE(opts.minlap, 3);
          write(P.seal(ml));
        }
        // 3) best-effort START (only if the Master needs arming; timing does
        //    NOT depend on this — crossings are consumed either way)
        if (opts.start) write(P.seal([P.SYNC, P.MSG.CMD, P.OP.START]));
      },
      onData:  chunk => parser.push(chunk),
      onClose: () => { /* keep lap counters across reconnects for gap detection */ },
    });
  } else if (opts.transport === 'ble') {
    warn('BLE transport not implemented yet — needs hardware. Use --transport tcp against the emulator.');
    process.exit(1);
  } else {
    warn(`unknown transport ${opts.transport}`);
    process.exit(2);
  }
}

log(`starting — transport=${opts.transport} circuit=${opts.circuit} laneOffset=${opts.laneOffset}` +
    `${opts.udp ? ` udp=${opts.udp.host}:${opts.udp.port}` : ''}${opts.dropRate ? ` dropRate=${opts.dropRate}` : ''}`);
startTransport();
