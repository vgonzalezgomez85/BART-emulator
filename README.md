# BART emulator + bridge

Banco de pruebas del protocolo **BART** (BLE Advanced Race Timer, Policar/Slot.it
`FL_BLE` rev 0.04) para integrarlo en SlotTime **sin necesitar hardware ni Bluetooth**.

Estudio completo del protocolo: `SloTime/BART-protocolo.md`.

## Idea

Separamos "protocolo" de "radio BLE". Todo el valor (parser, mapeo de carriles,
timing, detección de pérdidas) se prueba contra un emulador por **TCP**; el
Bluetooth real es un módulo enchufable que se añade al final, cuando haya hardware.

```
┌────────────┐  binario BART   ┌────────────┐   JSON/línea   ┌──────────────┐
│ emulator.js│  A5..CRC8 (TCP) │  bridge.js │  + UDP opcional│  SlotTime    │
│  BART_MST  │ ──────────────> │  (la "phone")──────────────>│ BartConnection│
│  máquina   │ <────────────── │  decodifica │   cruces       │ → lane_crossing
│  de estados│   comandos      │  + gaps     │   normalizados │ (pendiente)  │
└────────────┘                 └────────────┘                └──────────────┘
```

## Piezas

| Fichero | Qué es |
|---|---|
| `lib/protocol.js` | Protocolo binario: CRC-8 (poly 0x07), builders (LAP/ACK/STATUS), `FrameParser` con resync por byte `0xA5` + validación CRC. Compartido por emulador y puente. |
| `emulator.js` | **BART_MST virtual** sobre TCP `:9300`. Máquina de estados FREE/RUN/PAUSE/STOP, gating de notificaciones, filtro MinLap, ACKs. Genera vueltas sintéticas con jitter. |
| `emulator-ble.js` | **BART_MST por BLE real** (periférico GATT con `bleno`, Nordic UART Service). Para una VM Ubuntu / Raspberry Pi con radio BLE → SlotTime lo ve como un BART real. Ver `BLE-SETUP.md`. |
| `lib/master.js` | Máquina de estados del Master, **compartida** por el emulador TCP y el BLE (solo cambia el transporte). |
| `test-client.js` | "Phone" mínima de prueba: conecta, activa notificaciones, START, imprime vueltas. |
| `bridge.js` | **Puente** = lado BART de SlotTime. Decodifica el stream y emite **un JSON por cruce**. Transporte enchufable (`tcp` hoy, `ble` pendiente). Detección de huecos por contador de vueltas. |
| `scenarios/RegistroCarrera.txt` | Captura real de una carrera DS-300 (para reusarla como guion realista, pendiente de cablear). |

## Cómo probarlo (sin Bluetooth)

```bash
# terminal 1 — el BART virtual
node emulator.js                 # BART_LANES=4 BART_PORT=9300 por defecto

# terminal 2 — el puente: decodifica y saca JSON por stdout
node bridge.js --start --minlap 1500
# → {"v":1,"type":"lap","circuit":0,"lane":1,"laps":1,"lap_ms":5946,"ts_d10":59,"recv_ms":...,"gap":0}
```

Demostrar la **detección de pérdidas** (lo que el DS-300 no puede):

```bash
node bridge.js --start --drop-rate 0.35      # tira el 35% de las vueltas
# stderr: [bridge] gap on lane 2: 2 lap(s) lost (prev=3, now=6)
# stdout: ...,"laps":6,...,"gap":2   ← la pérdida queda detectada y marcada
```

## Formato JSON del cruce (lo que consumirá SlotTime)

```json
{ "v":1, "type":"lap", "circuit":0, "lane":3, "laps":5,
  "lap_ms":1834, "ts_d10":20930, "recv_ms":1733000000000, "gap":0 }
```

- `lane` ya es **global** (`lane_local + --lane-offset`), igual que el `laneOffset` de SerialService.
- `recv_ms` = reloj del puente. **Es la verdad temporal** (`ts_d10` es uint16 → envuelve a ~109 min; solo sirve de desempate de orden).
- `lap_ms` viene clampeado a uint16 (máx 65.535 s).
- `gap` = vueltas perdidas detectadas justo antes de esta (0 = ninguna).

## Opciones del puente

| Flag | Por defecto | Uso |
|---|---|---|
| `--transport tcp\|ble` | `tcp` | `ble` aún no implementado (necesita hardware/noble) |
| `--host` / `--port` | `127.0.0.1` / `9300` | dónde está el Master/emulador |
| `--circuit N` | `0` | índice de circuito (multi-master) |
| `--lane-offset N` | `0` | desplazamiento para numeración global de carriles |
| `--minlap MS` | (no enviar) | envía SET_MINLAP al conectar |
| `--start` | off | envía un START de una vez (armar el Master si lo necesita) |
| `--udp host:port` | off | además de stdout, emite cada cruce por UDP |
| `--drop-rate 0..1` | `0` | tira esa fracción de vueltas (demo de pérdida BLE) |

## Pendiente

1. **`BartConnection` en SlotTime** (`SerialService`): ingiere el JSON del puente y
   reemite `lane_crossing` → cero cambios aguas abajo (TimingService, etc.).
2. **Transporte `ble` real** (Layer B): cuando haya un BART físico o un dongle
   nRF52840. Solo cambia el módulo de transporte del puente; el resto no se toca.
3. (Opcional) guion `replay` en el emulador usando `scenarios/RegistroCarrera.txt`
   para que la simulación reproduzca una carrera real.
