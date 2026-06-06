'use strict';

// ============================================================================
//  BART Master emulator over REAL BLE  (periférico GATT)
//  Anuncia como "BART_MST" con el Nordic UART Service (NUS) y habla el mismo
//  protocolo binario BART que el emulador TCP. Para SlotTime (central, noble)
//  es indistinguible de un BART real.
//
//  Pensado para una máquina Linux con una radio BLE (Raspberry Pi, portátil
//  Linux, o VM Ubuntu con un dongle USB-BT por passthrough). Ver BLE-SETUP.md.
//
//    sudo systemctl stop bluetooth        # liberar el HCI para bleno
//    BART_LANES=24 sudo -E node emulator-ble.js
// ============================================================================

const bleno = require('@abandonware/bleno');
const P = require('./lib/protocol');
const { Master } = require('./lib/master');

const NAME      = process.env.BART_NAME   || 'BART_MST';
const NUM_LANES = Number(process.env.BART_LANES  || 4);
const MINLAP    = Number(process.env.BART_MINLAP || 2000);

// Nordic UART Service (UUID 128-bit, sin guiones para bleno)
const NUS_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX      = '6e400002b5a3f393e0a9e50e24dcca9e'; // phone → master (write)
const NUS_TX      = '6e400003b5a3f393e0a9e50e24dcca9e'; // master → phone (notify)

// ── Master + transporte BLE (notify) ────────────────────────────────────────
let txUpdate = null;                       // updateValueCallback cuando hay suscripción
function send(buf) { if (txUpdate) txUpdate(Buffer.from(buf)); }
const master = new Master(send, (...a) => console.log(...a), { lanes: NUM_LANES, minlap: MINLAP });

// Parser de comandos entrantes (Phone → Master). Cada write puede traer un
// comando; el FrameParser resincroniza por 0xA5 y valida CRC igual que en TCP.
const parser = new P.FrameParser(
  (msgType, op) => (msgType === P.MSG.CMD ? P.cmdLength(op) : null),
  ({ op, frame }) => {
    console.log(`[RX] CMD op=0x${op.toString(16).padStart(2, '0')}  [${P.hex(frame)}]`);
    master.handleCommand(op, frame);
  },
  (err) => console.log(`[!] frame ${err.type}${err.frame ? ' [' + P.hex(err.frame) + ']' : ''}`),
);

// ── Características GATT ──────────────────────────────────────────────────────
const txCharacteristic = new bleno.Characteristic({
  uuid: NUS_TX,
  properties: ['notify'],
  onSubscribe(maxValueSize, updateValueCallback) {
    console.log(`[+] central suscrito a TX (notify on, MTU payload=${maxValueSize})`);
    txUpdate = updateValueCallback;
    master.notify = true;                  // el canal está listo → fluyen LAP/STATUS
  },
  onUnsubscribe() {
    console.log('[-] central desuscrito de TX');
    txUpdate = null;
    master.notify = false;
    master.stopTimers();
  },
});

const rxCharacteristic = new bleno.Characteristic({
  uuid: NUS_RX,
  properties: ['write', 'writeWithoutResponse'],
  onWriteRequest(data, offset, withoutResponse, callback) {
    parser.push(data);
    callback(bleno.Characteristic.RESULT_SUCCESS);
  },
});

// ── Ciclo de vida bleno ──────────────────────────────────────────────────────
bleno.on('stateChange', (state) => {
  console.log('[bleno] estado:', state);
  if (state === 'poweredOn') {
    // Anunciamos SOLO el nombre (cabe en 31 bytes); el central escanea por
    // "BART_MST" y descubre el NUS tras conectar. Evita el límite del adv packet.
    bleno.startAdvertising(NAME, [], (err) => { if (err) console.error('[bleno] adv error:', err); });
  } else {
    bleno.stopAdvertising();
  }
});

bleno.on('advertisingStart', (err) => {
  if (err) { console.error('[bleno] advertisingStart error:', err); return; }
  console.log(`[bleno] anunciando como "${NAME}"  |  Lanes: ${NUM_LANES}  |  MinLap: ${MINLAP}ms`);
  bleno.setServices([
    new bleno.PrimaryService({ uuid: NUS_SERVICE, characteristics: [rxCharacteristic, txCharacteristic] }),
  ], (err2) => {
    if (err2) console.error('[bleno] setServices error:', err2);
    else console.log('[bleno] NUS listo. Esperando a SlotTime (central)…');
  });
});

bleno.on('accept', (addr) => {
  console.log(`[+] central conectado: ${addr}`);
  master.notify = false;                   // 7.5: off hasta suscripción/0x30
});

bleno.on('disconnect', (addr) => {
  console.log(`[-] central desconectado: ${addr}`);
  txUpdate = null;
  master.notify = false;
  master.stopTimers();
});

process.on('SIGINT', () => { try { bleno.stopAdvertising(); } catch {} process.exit(0); });
