'use strict';

// ============================================================================
//  BART Master state machine (transport-agnostic).
//  Lo usan el emulador TCP (emulator.js) y el BLE (emulator-ble.js): solo
//  cambia cómo se entregan los bytes (`send`) y de dónde llegan los comandos.
// ============================================================================

const P = require('./protocol');

// Tiempo base de vuelta por carril (ms); índice 1..N. Más allá → 6500.
const LANE_BASE = [0, 6200, 6600, 7000, 7400, 5800, 6900, 7200, 6100];

class Master {
  // send: (Buffer) => void   — escribe hacia el "phone" (TCP socket / notify BLE)
  // log:  (...args) => void
  // opts: { lanes=4, minlap=2000 }
  constructor(send, log, opts = {}) {
    this.send = send;
    this.log  = log || (() => {});
    this.numLanes = opts.lanes  || 4;
    this.minlap   = opts.minlap || 2000;
    this._replay  = (opts.replayEvents && opts.replayEvents.length) ? opts.replayEvents : null;
    this._replayTimers = [];
    this.state    = P.STATE.FREE;
    this.notify   = false;        // notifs off hasta CCCD/0x30 (7.5)
    this.bootTime = Date.now();
    this.raceStart = 0;
    this.lanes = {};
    for (let i = 1; i <= this.numLanes; i++) {
      this.lanes[i] = { laps: 0, lastCrossMs: 0, base: LANE_BASE[i] || 6500, timer: null };
    }
  }

  raceMs()    { return this.raceStart ? Date.now() - this.raceStart : 0; }
  uptimeD10() { return Math.floor((Date.now() - this.bootTime) / 100) & 0xFFFF; }

  // notificación (LAP/STATUS) — solo si el phone las habilitó
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
      if (lapMs < this.minlap) {                                  // filtro MinLap (8.3.1)
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
    for (const t of this._replayTimers) clearTimeout(t);
    this._replayTimers = [];
  }

  // Reanuda la generación de vueltas tras una RECONEXIÓN (sin reiniciar la
  // carrera): conserva raceStart y el contador de vueltas, solo vuelve a
  // programar los carriles. lastCrossMs se pone a "ahora" para que la primera
  // vuelta tras reconectar tenga duración normal (no una vuelta gigante que
  // abarque el corte). Un BART físico real reanudaría solo; esto lo emula.
  resumeLanes() {
    if (this.state !== P.STATE.RUN) return;
    if (this._replay) return;   // el replay es una línea temporal de una sola pasada; no se reanuda
    const now = this.raceMs();
    for (let i = 1; i <= this.numLanes; i++) {
      this.lanes[i].lastCrossMs = now;
      this.scheduleLane(i);
    }
    this.log('    (vueltas reanudadas tras reconexión)');
  }

  // ---- control de carrera ----
  start() {
    this.state = P.STATE.RUN;
    this.raceStart = Date.now();
    if (this._replay) { this._startReplay(); return; }     // guion de captura real
    for (let i = 1; i <= this.numLanes; i++) { this.lanes[i].lastCrossMs = 0; this.scheduleLane(i); }
  }

  // Reproduce una captura real (RegistroCarrera.txt) como vueltas BART: programa
  // cada cruce en su instante relativo y emite el LAP con su tiempo real.
  _startReplay() {
    const lastByLane = {};
    for (const ev of this._replay) {
      const t = setTimeout(() => {
        if (this.state !== P.STATE.RUN) return;
        const L = this.lanes[ev.lane];
        if (!L) return;
        const prev  = lastByLane[ev.lane];
        const lapMs = (prev != null) ? (ev.atMs - prev) : ev.atMs;  // 1ª vuelta = tiempo desde el inicio
        lastByLane[ev.lane] = ev.atMs;
        if (lapMs < this.minlap) { this.log(`    x lane ${ev.lane}: ${lapMs}ms < minlap (dropped)`); return; }
        L.laps += 1;
        const tsD10 = Math.floor(ev.atMs / 100) & 0xFFFF;
        const pkt = P.buildLap(ev.lane, L.laps, Math.min(Math.round(lapMs), 0xFFFF), tsD10);
        this.emit(pkt, `LAP[replay] lane=${ev.lane} laps=${L.laps} lap_ms=${Math.round(lapMs)} ts_d10=${tsD10}`);
      }, ev.atMs);
      this._replayTimers.push(t);
    }
    this.log(`    (replay: ${this._replay.length} cruces programados)`);
  }
  stop()  { this.state = P.STATE.STOP;  this.stopTimers(); }
  pause() { this.state = P.STATE.PAUSE; this.stopTimers(); }
  clear() {
    this.stopTimers();
    this.state = P.STATE.FREE;
    for (let i = 1; i <= this.numLanes; i++) { this.lanes[i].laps = 0; this.lanes[i].lastCrossMs = 0; }
  }

  statusPkt() { return P.buildStatus(this.state, this.minlap, this.uptimeD10(), this.numLanes); }
  sendStatus() {
    const p = this.statusPkt();
    this.send(p);
    this.log(`    -> STATUS state=${P.STATE_NAME[this.state]} minlap=${this.minlap} lanes=${this.numLanes}  [${P.hex(p)}]`);
  }
  autoStatus() { if (this.notify) this.sendStatus(); } // en transiciones (7.2)

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
        this.send(P.buildAck(op, P.RESULT.OK));   // 7.1: ACK siempre
        if (this.notify) { this.log('    (notifications ENABLED)'); this.resumeLanes(); }
        break;
      default:
        this.send(P.buildAck(op, P.RESULT.UNKNOWN_OP));
    }
  }
}

module.exports = { Master, LANE_BASE };
