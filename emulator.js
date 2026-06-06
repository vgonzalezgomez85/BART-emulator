'use strict';

// ============================================================================
//  BART Master emulator  (BART_MST)
//  Speaks the real BART binary protocol over a TCP socket (loopback).
//  Point SlotTime -- or test-client.js -- at 127.0.0.1:9300.
//
//    node emulator.js
//    BART_LANES=4 BART_PORT=9300 node emulator.js
// ============================================================================

const net = require('net');
const P = require('./lib/protocol');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BART_PORT || 9300);
const NUM_LANES = Number(process.env.BART_LANES || 4);
const DEFAULT_MINLAP = 2000; // ms

// rough base lap time per lane (ms); lane index 1..N
const LANE_BASE = [0, 6200, 6600, 7000, 7400, 5800, 6900, 7200, 6100];

class Master {
  constructor(send, log) {
    this.send = send;            // (Buffer) => void  (raw write to the phone)
    this.log = log;
    this.state = P.STATE.FREE;
    this.minlap = DEFAULT_MINLAP;
    this.notify = false;         // notifications disabled until CCCD/0x30 (7.5)
    this.bootTime = Date.now();
    this.raceStart = 0;
    this.lanes = {};
    for (let i = 1; i <= NUM_LANES; i++) {
      this.lanes[i] = { laps: 0, lastCrossMs: 0, base: LANE_BASE[i] || 6500, timer: null };
    }
  }

  raceMs() { return this.raceStart ? Date.now() - this.raceStart : 0; }
  uptimeD10() { return Math.floor((Date.now() - this.bootTime) / 100) & 0xFFFF; }

  // stream a notification (LAP/STATUS) -- only when the phone enabled them
  emit(buf, label) {
    if (this.notify) this.send(buf);
    this.log(`    -> ${label}  [${P.hex(buf)}]${this.notify ? '' : '   (held: notify OFF)'}`);
  }

  scheduleLane(lane) {
    const L = this.lanes[lane];
    if (L.timer) clearTimeout(L.timer);
    const jitter = 1 + (Math.random() * 0.1 - 0.05);             // +/-5%
    const dt = Math.max(this.minlap, Math.round(L.base * jitter));
    L.timer = setTimeout(() => {
      if (this.state !== P.STATE.RUN) return;
      const now = this.raceMs();
      const lapMs = L.lastCrossMs ? now - L.lastCrossMs : dt;
      if (lapMs < this.minlap) {                                  // MinLap filter (8.3.1)
        this.log(`    x lane ${lane}: ${lapMs}ms < minlap ${this.minlap}ms (dropped)`);
      } else {
        L.laps += 1;
        L.lastCrossMs = now;
        const tsD10 = Math.floor(now / 100) & 0xFFFF;
        const pkt = P.buildLap(lane, L.laps, Math.min(lapMs, 0xFFFF), tsD10);
        this.emit(pkt, `LAP    lane=${lane} laps=${L.laps} lap_ms=${lapMs} ts_d10=${tsD10}`);
      }
      if (this.state === P.STATE.RUN) this.scheduleLane(lane);
    }, dt);
  }

  stopTimers() {
    for (const i of Object.keys(this.lanes)) {
      const L = this.lanes[i];
      if (L.timer) { clearTimeout(L.timer); L.timer = null; }
    }
  }

  // ---- race control ----
  start() {
    this.state = P.STATE.RUN;
    this.raceStart = Date.now();
    for (let i = 1; i <= NUM_LANES; i++) { this.lanes[i].lastCrossMs = 0; this.scheduleLane(i); }
  }
  stop()  { this.state = P.STATE.STOP;  this.stopTimers(); }
  pause() { this.state = P.STATE.PAUSE; this.stopTimers(); }
  clear() {
    this.stopTimers();
    this.state = P.STATE.FREE;
    for (let i = 1; i <= NUM_LANES; i++) { this.lanes[i].laps = 0; this.lanes[i].lastCrossMs = 0; }
  }

  statusPkt() { return P.buildStatus(this.state, this.minlap, this.uptimeD10(), NUM_LANES); }
  sendStatus() {                                  // direct response (always sent)
    const p = this.statusPkt();
    this.send(p);
    this.log(`    -> STATUS state=${P.STATE_NAME[this.state]} minlap=${this.minlap} lanes=${NUM_LANES}  [${P.hex(p)}]`);
  }
  autoStatus() { if (this.notify) this.sendStatus(); } // on state transitions (7.2)

  handleCommand(op, frame) {
    switch (op) {
      case P.OP.START: this.start(); this.send(P.buildAck(op, P.RESULT.OK)); this.autoStatus(); break;
      case P.OP.STOP:  this.stop();  this.send(P.buildAck(op, P.RESULT.OK)); this.autoStatus(); break;
      case P.OP.PAUSE: this.pause(); this.send(P.buildAck(op, P.RESULT.OK)); this.autoStatus(); break;
      case P.OP.CLEAR: this.clear(); this.send(P.buildAck(op, P.RESULT.OK)); this.autoStatus(); break;
      case P.OP.SET_MINLAP:
        if (frame.length !== 6) { this.send(P.buildAck(op, P.RESULT.BAD_LENGTH)); break; }
        this.minlap = frame.readUInt16LE(3);
        this.send(P.buildAck(op, P.RESULT.OK));
        break;
      case P.OP.READ_STAT:
        this.send(P.buildAck(op, P.RESULT.OK));
        this.sendStatus();
        break;
      case P.OP.NOTIFY:
        this.notify = (frame[3] === 0x01);
        this.send(P.buildAck(op, P.RESULT.OK));   // 7.1: ACK always returned
        if (this.notify) this.log('    (notifications ENABLED)');
        break;
      default:
        this.send(P.buildAck(op, P.RESULT.UNKNOWN_OP));
    }
  }
}

// ---- TCP transport --------------------------------------------------------
let socket = null;
function send(buf) { if (socket && !socket.destroyed) socket.write(buf); }
const master = new Master(send, (...a) => console.log(...a));

const server = net.createServer((s) => {
  console.log(`\n[+] phone connected ${s.remoteAddress}:${s.remotePort}`);
  socket = s;
  master.notify = false;                          // 7.5: off on connect

  const parser = new P.FrameParser(
    (msgType, op) => (msgType === P.MSG.CMD ? P.cmdLength(op) : null),
    ({ op, frame }) => {
      console.log(`[RX] CMD op=0x${op.toString(16).padStart(2, '0')}  [${P.hex(frame)}]`);
      master.handleCommand(op, frame);
    },
    (err) => console.log(`[!] frame ${err.type}${err.frame ? ' [' + P.hex(err.frame) + ']' : ''}`)
  );

  s.on('data', (d) => parser.push(d));
  s.on('close', () => {
    console.log('[-] phone disconnected');
    if (socket === s) socket = null;
    master.notify = false;
    master.stopTimers();
  });
  s.on('error', (e) => console.log(`[!] socket: ${e.message}`));
});

server.listen(PORT, HOST, () => {
  console.log(`BART Master emulated (BART_MST) listening on ${HOST}:${PORT}`);
  console.log(`Lanes: ${NUM_LANES}  |  MinLap: ${master.minlap}ms`);
  console.log('Waiting for SlotTime (or test-client.js) to connect...');
});
