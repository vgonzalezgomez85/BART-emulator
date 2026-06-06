#!/usr/bin/env bash
# End-to-end demo with NO Bluetooth: emulator -> bridge -> JSON crossings.
# Usage:  ./demo.sh            (clean run)
#         ./demo.sh 0.35       (simulate 35% BLE loss to show gap detection)
set -euo pipefail
cd "$(dirname "$0")"

DROP="${1:-0}"
SECS="${2:-15}"

echo "▶ starting BART emulator (BART_MST on :9300)…"
node emulator.js >/tmp/bart_emu.log 2>&1 &
EMU=$!
sleep 1

echo "▶ starting bridge (--start --minlap 1500 --drop-rate $DROP) for ${SECS}s…"
echo "──────────────────────────────────────────────────────────────────────"
node bridge.js --start --minlap 1500 --drop-rate "$DROP" 2>/tmp/bart_bridge.err &
BRG=$!
sleep "$SECS"

kill "$BRG" 2>/dev/null || true
kill "$EMU" 2>/dev/null || true
echo "──────────────────────────────────────────────────────────────────────"
if [ "$DROP" != "0" ]; then
  echo "▶ gaps detected via the cumulative lap counter:"
  grep -i "gap on" /tmp/bart_bridge.err || echo "  (none this run — try a higher drop rate or more seconds)"
fi
echo "✔ done."
