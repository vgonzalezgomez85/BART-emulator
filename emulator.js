'use strict';

// ============================================================================
//  BART Master emulator  (BART_MST)
//  Speaks the real BART binary protocol over a TCP socket (loopback).
//  Point SlotTime -- or test-client.js -- at 127.0.0.1:9300.
//
//    node emulator.js
//    BART_LANES=4 BART_PORT=9300 node emulator.js
// ============================================================================

const net  = require('net');
const path = require('path');
const P = require('./lib/protocol');
const { Master } = require('./lib/master');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BART_PORT || 9300);
const NUM_LANES = Number(process.env.BART_LANES || 4);
const DEFAULT_MINLAP = 2000; // ms

// Escenario: 'synthetic' (vueltas aleatorias) o 'replay' (captura real).
//   BART_SCENARIO=replay BART_REPLAY=scenarios/RegistroCarrera.txt node emulator.js
const { replayEvents, replayLanes } = loadScenario();
function loadScenario() {
  if ((process.env.BART_SCENARIO || 'synthetic') !== 'replay') return {};
  const file = process.env.BART_REPLAY || path.join(__dirname, 'scenarios', 'RegistroCarrera.txt');
  const { parseCapture } = require('./lib/replay');
  const r = parseCapture(file);
  console.log(`[replay] ${r.events.length} cruces, ${r.lanes} carriles desde ${file}${r.error ? ' (ERROR: ' + r.error + ')' : ''}`);
  return { replayEvents: r.events, replayLanes: r.lanes };
}

// ---- TCP transport --------------------------------------------------------
let socket = null;
function send(buf) { if (socket && !socket.destroyed) socket.write(buf); }
const master = new Master(send, (...a) => console.log(...a), {
  lanes: replayLanes || NUM_LANES, minlap: DEFAULT_MINLAP, replayEvents,
});

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
  console.log(`Lanes: ${master.numLanes}  |  MinLap: ${master.minlap}ms${replayEvents ? '  |  REPLAY' : ''}`);
  console.log('Waiting for SlotTime (or test-client.js) to connect...');
});
