# Emulador BART por BLE real — montaje en VM Ubuntu

Objetivo: que `emulator-ble.js` anuncie como **`BART_MST`** (periférico BLE con
Nordic UART Service) desde una VM Ubuntu, para que SlotTime (en el Mac, central
con `noble`) lo vea como un BART real.

```
VM Ubuntu (radio BLE)                 Mac = SlotTime
emulator-ble.js (bleno)   ──BLE──>    BartConnection (noble, transporte ble)
  anuncia "BART_MST" (NUS)            escanea, suscribe TX, escribe RX
```

## 1. Dar una radio BLE a la VM

Una VM **no tiene Bluetooth**: hay que pasarle una radio por USB.

- **Recomendado:** un **dongle USB-BT** y *USB passthrough* a la VM (VirtualBox:
  Dispositivos → USB → marcar el dongle; VMware: Removable Devices → Connect).
  Así el host conserva su Bluetooth.
- El BT **interno** del portátil normalmente NO se puede pasar limpio a la VM.

> El dongle debe soportar modo periférico/advertising (CSR 4.0, Realtek… valen).

## 2. Verificar la radio DENTRO de la VM (antes de nada)

```bash
sudo apt update
sudo apt install -y bluetooth bluez libbluetooth-dev build-essential

hciconfig -a                 # debe aparecer hci0 (el dongle)
sudo hciconfig hci0 up
bluetoothctl                 # > show  → debe listar el controlador; luego: exit
```

Si `hci0` aparece y sube, vas bien. Si no, el passthrough del USB no llegó.

## 3. Node + dependencias

```bash
# Node 18 LTS (nvm o nodesource)
node -v

cd bart-emulator
npm install                  # instala @abandonware/bleno (compila con bluez)
```

## 4. Liberar el HCI y arrancar

bleno necesita el adaptador libre (si BlueZ lo "posee", choca):

```bash
sudo systemctl stop bluetooth          # libera hci0 para bleno
# permitir BLE sin root (una vez):
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))

BART_LANES=24 node emulator-ble.js
# o, si setcap no aplicó:  BART_LANES=24 sudo -E node emulator-ble.js
```

Salida esperada:
```
[bleno] estado: poweredOn
[bleno] anunciando como "BART_MST"  |  Lanes: 24  |  MinLap: 2000ms
[bleno] NUS listo. Esperando a SlotTime (central)…
```

## 5. Comprobar el anuncio desde el Mac (opcional, sanity check)

En el Mac, con cualquier app BLE (p.ej. **nRF Connect** / **LightBlue**), escanea:
debe aparecer **`BART_MST`**. Si lo ves, SlotTime también lo verá.

## 6. SlotTime (el central)

Falta el transporte `ble` en `BartConnection` (con `@abandonware/noble` en el
Mac). Es la variante de `_openTransport()` ya prevista: escanear `BART_MST`,
suscribir la característica TX (notify) y escribir comandos en RX. Una vez
montado, en Ajustes se elegiría transporte BLE en lugar de TCP.

## Problemas típicos

| Síntoma | Causa / arreglo |
|---|---|
| `hci0` no aparece | El dongle no se pasó a la VM (revisar USB passthrough) |
| `Error: Command Disallowed` / no anuncia | BlueZ tiene el adaptador: `sudo systemctl stop bluetooth` |
| `EPERM` / permisos | `setcap cap_net_raw+eip` a node, o ejecutar con `sudo -E` |
| Falla al compilar bleno | `sudo apt install libbluetooth-dev build-essential` |
| El central no encuentra `BART_MST` | Acercar las máquinas; confirmar advertising activo |
