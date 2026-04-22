#!/usr/bin/env bash
#
# Demo script used to produce docs/demo.gif.
# Recorded with:
#   asciinema rec --overwrite -c "bash demo/demo.sh" demo/demo.cast
# Rendered with:
#   agg --cols 96 --rows 28 --font-size 16 --speed 1.2 \
#       demo/demo.cast docs/demo.gif
#
# The script simulates a Node-RED deploy: it boots the broker node,
# runs a pub/sub round-trip, asks for status, and shuts the broker
# down cleanly - all against the real mosquitto binary installed by
# the module's postinstall step.
set -u

# --- tiny typewriter helpers ---------------------------------------------
say()    { printf '\033[1;36m$ \033[0;37m%s\033[0m\n' "$*"; }
note()   { printf '\033[0;33m# %s\033[0m\n' "$*"; sleep 0.6; }
pause()  { sleep "${1:-0.8}"; }

clear
note "node-red-contrib-mosquitto-broker - demo"
pause 1

note "1) mosquitto already installed by the module postinstall"
say  "mosquitto -h | head -n 1"
mosquitto -h 2>&1 | head -n 1
pause

note "2) Boot the broker the way Node-RED does (minimal RED harness)"
say  "node demo/run-broker.js &"
node demo/run-broker.js &
BROKER_PID=$!
sleep 2

note "3) Subscribe to test/demo in the background"
say  "mosquitto_sub -h 127.0.0.1 -p 18840 -t test/demo -v &"
mosquitto_sub -h 127.0.0.1 -p 18840 -t 'test/demo' -v -W 8 &
SUB_PID=$!
sleep 1

note "4) Publish a message through the brokered node"
say  "mosquitto_pub -h 127.0.0.1 -p 18840 -t test/demo -m 'hello from Node-RED'"
mosquitto_pub -h 127.0.0.1 -p 18840 -t 'test/demo' -m 'hello from Node-RED'
sleep 1.2

note "5) Confirm the broker is actually listening on :18840"
say  "ss -ltn | awk 'NR==1 || /:18840 /'"
ss -ltn | awk 'NR==1 || /:18840 /'
pause

note "6) Clean shutdown (same path as Node-RED redeploy)"
say  "kill -TERM $BROKER_PID   # SIGTERM -> node calls stop() -> mosquitto exits"
kill -TERM "$BROKER_PID" 2>/dev/null || true
wait "$BROKER_PID" 2>/dev/null || true
kill "$SUB_PID" 2>/dev/null || true
sleep 0.8

note "Done."
pause 1.5
