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
const { Master } = require('./lib/master');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BART_PORT || 9300);
const NUM_LANES = Number(process.env.BART_LANES || 4);
const DEFAULT_MINLAP = 2000; // ms

// ---- TCP transport --------------------------------------------------------
let socket = null;
function send(buf) { if (socket && !socket.destroyed) socket.write(buf); }
const master = new Master(send, (...a) => console.log(...a), { lanes: NUM_LANES, minlap: DEFAULT_MINLAP });

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
