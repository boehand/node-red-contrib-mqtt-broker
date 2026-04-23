# node-red-contrib-mqtt-broker

Node-RED Node, der einen **Mosquitto-MQTT-Broker** als Kindprozess von Node-RED
startet und verwaltet. Ein Node-RED-Deploy startet den Broker, ein Redeploy oder
Shutdown stoppt ihn sauber. Der Node bringt die nötigen System-Voraussetzungen
per Auto-Install mit — Linux, macOS und Windows 10/11.

![Demo](docs/demo.gif)

---

## Features

- **Mosquitto wird automatisch mitinstalliert** (apt/dnf/yum/zypper/pacman/apk auf
  Linux, Homebrew auf macOS, winget/choco/Direct-Download auf Windows).
- **Self-Heal**: fehlt das Binary beim ersten Deploy, läuft die Installation
  nochmal interaktiv (wichtig auf Windows, wo der UAC-Prompt im
  `npm install` des Palette-Managers nicht hochkommen kann).
- **Volle Broker-Kontrolle per Message**: `start`, `stop`, `restart`, `status`,
  `install`.
- **Topic-Inspektion**: `topics` listet alle gesehenen Topic-Namen; `get`
  liefert den letzten Wert eines Topics inkl. Rohdaten, QoS und Zeitstempel.
- **Konfigurierbar per UI**: Port, Bind-Adresse, Anonymous, Persistence,
  Username/Password, optional eigene `mosquitto.conf`.
- Outputs Broker-Logs als Node-RED-Messages (`mosquitto/stdout`, `mosquitto/stderr`).
- **Auto-Restart** bei unerwartetem Exit (5 s Backoff).

---

## Installation

### Über Node-RED Palette (empfohlen)

1. In Node-RED: ☰ → **Manage palette** → Tab **Install**.
2. Nach `node-red-contrib-mqtt-broker` suchen → **Install**, ODER
3. Über das Upload-Icon das `.tgz` aus `dist/` hochladen.

Der Postinstall läuft im Hintergrund und installiert Mosquitto. Schlägt er fehl
(z. B. UAC verweigert), startet die Installation beim ersten Deploy erneut —
siehe Self-Heal.

### Über die Kommandozeile

```bash
cd ~/.node-red
npm install node-red-contrib-mqtt-broker
# Linux: benötigt root oder passwordless sudo
# Windows: winget-Installer läuft bevorzugt per-user (kein UAC)
```

### Install-Verhalten steuern

| Variable | Wirkung |
|---|---|
| `SKIP_MOSQUITTO_INSTALL=1` | Postinstall wird übersprungen |
| `MOSQUITTO_WIN_VERSION=2.0.20` | Pin der Installer-Version beim Windows-Fallback |

Zur manuellen Nachinstallation:
```bash
npm run install-mosquitto    # im Modul-Verzeichnis
```

---

## Konfigurationsfelder

| Feld | Default | Beschreibung |
|---|---|---|
| Port | `1883` | Listen-Port |
| Bind | _(leer)_ | IP zum Binden; leer = alle Interfaces |
| Allow anonymous | `true` | Erlaubt Zugriff ohne Credentials |
| Persistence | `false` | Mosquitto-Persistenz in temporärem Verzeichnis |
| Username / Password | — | Optional; Password-File wird via `mosquitto_passwd` gehasht |
| Binary | _(leer)_ | Pfad zu `mosquitto`/`mosquitto.exe`; leer = Auto-Lookup |
| Config file | _(leer)_ | Eigene `.conf`; überschreibt alle obigen Felder |
| Log to Node-RED console | `false` | Broker-Logs zusätzlich ins Node-RED-Log |

---

## Input-Commands

Payload als String oder als Objekt `{ command: "…", … }`.

| Command | Beschreibung | Output-Topic |
|---|---|---|
| `start` | Broker starten | — |
| `stop` | Broker stoppen | — |
| `restart` | Broker neu starten | — |
| `status` | Laufzeitzustand abfragen | `mosquitto/status` |
| `install` | Auto-Install (nochmal) auslösen | `mosquitto/install` |
| `topics` | Alle gesehenen Topics sortiert | `mosquitto/topics` |
| `get` | Letzter Wert für ein Topic | `mosquitto/get` |

**Beispiele:**
```js
// Liste aller Topics
msg.payload = "topics";

// Wert eines Topics - beide Formen funktionieren
msg.payload = { command: "get", topic: "sensors/temp" };

msg.topic = "sensors/temp";
msg.payload = "get";
```

---

## Output-Nachrichten

| `msg.topic` | `msg.payload` |
|---|---|
| `mosquitto/stdout` | stdout-Zeile des Brokers |
| `mosquitto/stderr` | stderr-Zeile |
| `mosquitto/status` | `{ running, port, bind, binary }` |
| `mosquitto/install` | `{ ok, binary }` |
| `mosquitto/topics` | `string[]` — Topic-Namen, sortiert |
| `mosquitto/get` | `{ topic, found, value, buffer, qos, retain, timestamp }` |

`value` ist die UTF-8-Dekodierung; `buffer` der rohe `Buffer` (für binäre
Payloads).

**MQTT-Semantik zum `retain`-Flag:** `retain=true` kommt nur bei historischer
Zustellung direkt nach einem `subscribe` an. Live-Nachrichten haben immer
`retain=false`, auch wenn sie mit `-r` publiziert wurden — das ist
MQTT-Standard, kein Bug des Nodes.

---

## Beispiel-Flow

Ein fertiger Flow liegt unter [`examples/mqtt-broker.json`](examples/mqtt-broker.json).
Er startet den Broker, schickt `status` per Inject und zeigt die Antwort im Debug-Panel.

Für die Topic-Inspektion hängst du einen zweiten Inject mit `payload=topics`
bzw. `payload={command:"get",topic:"sensors/temp"}` dran.

---

## Entwicklung

```bash
# Tests (End-to-End gegen eine echte Mosquitto-Instanz)
npm test

# Terminal-Demo neu aufnehmen + GIF rendern
npm run demo          # benötigt asciinema + agg
```

Der Integrationstest startet den Broker über einen Minimal-RED-Mock, pubt
/subscribet mit `mosquitto_pub`/`mosquitto_sub`, prüft `topics` + `get` und
verifiziert den sauberen Shutdown.

---

## Troubleshooting

| Symptom | Ursache & Lösung |
|---|---|
| Status **rot**, „spawn error ENOENT" | Binary nicht installiert. Einmal `install` per Message triggern oder `npm run install-mosquitto`. Auf Windows: UAC-Prompt bestätigen. |
| Status **rot**, „port 1883 in use" | Ein anderer Broker läuft schon (häufig der System-Dienst). Port ändern oder Dienst stoppen (`sudo systemctl stop mosquitto`). |
| `topics` bleibt leer | Der interne Tracking-Client braucht einen kurzen Moment zum Verbinden. Erst publishen, dann nach ~1 s abfragen. |
| Auth-Test schlägt fehl | `mosquitto_passwd` fehlt → Password-File wurde nicht gehasht. `mosquitto-clients` installieren. |

---

## Lizenz

Apache-2.0
