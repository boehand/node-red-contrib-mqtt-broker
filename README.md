# node-red-contrib-mqtt-broker

A Node-RED node that runs a **Mosquitto MQTT broker** as a child process of
Node-RED. A deploy starts the broker; a redeploy or shutdown stops it cleanly.
The module ships with an auto-installer for the underlying binary — Linux,
macOS, and Windows 10/11.

![Demo](docs/video_node-red-contrib-mqtt-broker.webp)

---

## Features

- **Mosquitto is installed automatically** (apt/dnf/yum/zypper/pacman/apk on
  Linux, Homebrew on macOS, winget/choco/direct download on Windows).
- **Install scope is selectable** — reuse an existing system install
  (*auto*), force a system-wide install (*global*), or install a private
  copy inside the module's `vendor/` directory (*local*). The node always
  checks for an existing mosquitto before installing, to avoid duplicates.
- **Update check**: after start and every _N_ minutes (default 15,
  configurable), the node queries the official Mosquitto release feed and
  reports on `mosquitto/update`. Send `payload: "update"` to install a
  newer version without manual steps.
- **Self-heal**: if the binary is missing at first deploy, the installer runs
  again interactively — important on Windows, where the UAC prompt cannot
  surface during the palette manager's `npm install`.
- **Full broker control via messages**: `start`, `stop`, `restart`, `status`,
  `install`, `check-update`, `update`.
- **Topic inspection**: `topics` lists every topic name the broker has seen;
  `get` returns the last value of a topic together with raw bytes, QoS, and
  timestamp.
- **UI-configurable**: port, bind address, anonymous access, persistence
  (with an editable `persistence_location` path), username/password,
  install scope, update-check interval, optional custom `mosquitto.conf`.
- Emits broker logs as Node-RED messages (`mosquitto/stdout`,
  `mosquitto/stderr`).
- **Auto-restart** on unexpected exit (5 s backoff).

---

## Installation

### Via the Node-RED palette (recommended)

1. In Node-RED: ☰ → **Manage palette** → **Install** tab.
2. Search for `node-red-contrib-mqtt-broker` → **Install**, OR
3. Use the upload icon to install the `.tgz` from `dist/`.

The post-install runs in the background and installs Mosquitto. If it fails
(for example, UAC denied), the install is retried on first deploy — see
Self-heal.

### From the command line

```bash
cd ~/.node-red
npm install node-red-contrib-mqtt-broker
# Linux: requires root or passwordless sudo
# Windows: winget installer runs per-user first (no UAC prompt)
```

### Controlling the installer

| Variable | Effect |
|---|---|
| `SKIP_MOSQUITTO_INSTALL=1` | Skip the post-install step |
| `MOSQUITTO_WIN_VERSION=2.0.20` | Pin the installer version used by the Windows direct-download fallback |

Re-run the installer on demand:
```bash
npm run install-mosquitto    # from the module directory
```

---

## Configuration fields

| Field | Default | Description |
|---|---|---|
| Port | `1883` | Listen port |
| Bind | _(empty)_ | IP to bind; empty = all interfaces |
| Allow anonymous | `true` | Allow clients without credentials |
| Persistence | `false` | Turn on Mosquitto persistence |
| Persistence path | _(empty)_ | `persistence_location` directory. Editable; empty = `<Node-RED userDir>/mqtt-broker-persistence/<node-id>/` (shown as placeholder in the editor) so data survives restarts |
| Username / Password | — | Optional; the password file is hashed via `mosquitto_passwd` |
| Install scope | `auto` | `auto` / `global` / `local` — see below |
| Mosquitto binary | _(empty)_ | Absolute path to the `mosquitto` executable. Leave empty to auto-locate via the install scope. Set only to pin a specific build; then the install scope / auto-installer is bypassed |
| Config file | _(empty)_ | Custom `.conf`; overrides every field above |
| Check for updates | `true` | Poll the Mosquitto release feed for a newer version |
| Interval (min) | `15` | Update-check period in minutes |
| Show broker logs in Debug sidebar | `false` | When on, stdout/stderr is also surfaced via `node.warn()` so it appears in the Node-RED Debug sidebar and the server log |

### Install scope

| Scope | Behaviour |
|---|---|
| `auto` (default) | Re-use any mosquitto already present on the machine. If nothing is found, install **locally** first (no sudo, no system pollution) and only fall back to a global install if the local path isn't available. No duplicate installs. |
| `global` | System-wide install via the OS package manager (apt/dnf/yum/zypper/pacman/apk, Homebrew, winget/choco/direct download). Skipped if a global copy already exists. |
| `local` | Install a private copy inside `node-red-contrib-mqtt-broker/vendor/<platform>-<arch>/`. Linux (Debian family) uses `apt-get download` + `dpkg-deb -x` without root; Windows uses the NSIS installer with `/D=<vendor dir>`. macOS does not currently support a local install. If a global copy is also present, the node logs a note and uses the local one. |

---

## Input commands

Payload as a string or as an object `{ command: "…", … }`.

| Command | Description | Output topic |
|---|---|---|
| `start` | Start the broker | — |
| `stop` | Stop the broker | — |
| `restart` | Restart the broker | — |
| `status` | Report runtime state | `mosquitto/status` |
| `install` | Re-run the auto-installer. Accepts an optional `scope` override: `{ command:"install", scope:"local" }`. | `mosquitto/install` |
| `check-update` | Force an immediate update check | `mosquitto/update` |
| `update` | Install the newest mosquitto release using the configured scope. Broker is stopped for the install and re-started afterwards. | `mosquitto/update` |
| `topics` | Sorted list of every topic seen | `mosquitto/topics` |
| `get` | Last value for a single topic | `mosquitto/get` |

**Examples:**
```js
// List all topics
msg.payload = "topics";

// Fetch a topic value - either form works
msg.payload = { command: "get", topic: "sensors/temp" };

msg.topic = "sensors/temp";
msg.payload = "get";
```

---

## Output messages

| `msg.topic` | `msg.payload` |
|---|---|
| `mosquitto/stdout` | stdout line from the broker |
| `mosquitto/stderr` | stderr line |
| `mosquitto/status` | `{ running, port, bind, binary, scope, persistence, persistenceLocation, updateCheckEnabled, updateCheckIntervalMin, lastUpdateInfo }` |
| `mosquitto/install` | `{ ok, binary, scope, alreadyInstalled }` |
| `mosquitto/update` | `{ installed, latest, updateAvailable, updated?, scope?, path?, checkedAt }` |
| `mosquitto/topics` | `string[]` — topic names, sorted |
| `mosquitto/get` | `{ topic, found, value, buffer, qos, retain, timestamp }` |

`value` is the UTF-8 decoded payload; `buffer` is the raw `Buffer` (for binary
payloads).

**MQTT note on the `retain` flag:** `retain=true` is only set on messages
delivered to a fresh subscriber (historical delivery). Live messages always
arrive with `retain=false`, even when published with `-r` — that's standard
MQTT behaviour, not a bug in this node.

---

## Example flow

A ready-made flow lives at [`examples/mqtt-broker.json`](examples/mqtt-broker.json).
It starts the broker, sends `status` via an Inject node, and prints the
response in the Debug panel.

For topic inspection, wire a second Inject with `payload=topics` or
`payload={command:"get",topic:"sensors/temp"}` into the same broker node.

---

## Development

```bash
# End-to-end test against a real Mosquitto instance
npm test

# Re-record the terminal demo and render the GIF
npm run demo          # requires asciinema + agg
```

The integration test boots the broker through a minimal RED mock,
publishes/subscribes with `mosquitto_pub`/`mosquitto_sub`, exercises
`topics` + `get`, and verifies a clean shutdown.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Status **red**, "spawn error ENOENT" | Binary not installed. Send `install` as a message, or run `npm run install-mosquitto`. On Windows: accept the UAC prompt. |
| Status **red**, "port 1883 in use" | Another broker is already running (often the system service). Change the port, or stop the service (`sudo systemctl stop mosquitto`). |
| `topics` stays empty | The internal tracking client needs a moment to connect. Publish first, then query after ~1 s. |
| Auth test fails | `mosquitto_passwd` is missing, so the password file was not hashed. Install the `mosquitto-clients` package. |

---

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

## Author

Created by boehand using Claude Opus 4.7

---

For issues and feature requests, please file an issue on the GitHub repository.
