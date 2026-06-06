'use strict';

// ============================================================================
//  Minimal BART "phone" -- stands in for SlotTime to prove the emulator works.
//  Connects, enables notifications, sets MinLap, starts a race, prints decoded
//  laps, asks for status, then stops.   Run AFTER emulator.js is up:
//
//    node test-client.js
// ============================================================================

const net = require('net');
const P = require('./lib/protocol');

const PORT = Number(process.env.BART_PORT || 9300);

const sock = net.connect(PORT, '127.0.0.1', () => {
  console.log('[client] connected to emulated Master\n');
  send(P.seal([P.SYNC, P.MSG.CMD, P.OP.NOTIFY, 0x01]), 'NOTIFY ON');

  const ml = Buffer.alloc(5);                       // SET_MINLAP 1500ms
  ml[0] = P.SYNC; ml[1] = P.MSG.CMD; ml[2] = P.OP.SET_MINLAP; ml.writeUInt16LE(1500, 3);
  send(P.seal(ml), 'SET_MINLAP 1500');

  send(P.seal([P.SYNC, P.MSG.CMD, P.OP.START]), 'START');

  setTimeout(() => send(P.seal([P.SYNC, P.MSG.CMD, P.OP.READ_STAT]), 'READ_STAT'), 9000);
  setTimeout(() => send(P.seal([P.SYNC, P.MSG.CMD, P.OP.STOP]), 'STOP'), 16000);
  setTimeout(() => { sock.end(); process.exit(0); }, 17500);
});

function send(buf, label) {
  console.log(`[client] -> ${label}  [${P.hex(buf)}]`);
  sock.write(buf);
}

const parser = new P.FrameParser(
  (msgType) => P.notifyLength(msgType),
  ({ msgType, frame }) => decode(msgType, frame),
  (err) => console.log(`[client] frame ${err.type}`)
);
sock.on('data', (d) => parser.push(d));
sock.on('close', () => console.log('\n[client] disconnected'));
sock.on('error', (e) => console.log(`[client] error: ${e.message}`));

function decode(msgType, f) {
  if (msgType === P.MSG.LAP) {
    const lane = f[3], laps = f.readUInt16LE(4), lapMs = f.readUInt16LE(6), ts = f.readUInt16LE(8);
    console.log(`[client]   LAP  lane ${lane} | lap #${laps} | ${(lapMs / 1000).toFixed(3)}s | t=${(ts / 10).toFixed(1)}s`);
  } else if (msgType === P.MSG.ACK) {
    console.log(`[client]   ACK  op=0x${f[2].toString(16).padStart(2, '0')} result=0x${f[3].toString(16).padStart(2, '0')}`);
  } else if (msgType === P.MSG.STATUS) {
    const st = f[3], ml = f.readUInt16LE(4), up = f.readUInt16LE(6), ln = f[8];
    console.log(`[client]   STATUS state=${P.STATE_NAME[st]} minlap=${ml}ms uptime=${(up / 10).toFixed(1)}s lanes=${ln}`);
  }
}
