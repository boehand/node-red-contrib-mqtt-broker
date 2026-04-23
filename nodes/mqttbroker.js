module.exports = function (RED) {
    'use strict';

    const { spawn } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const net = require('net');
    const mqtt = require('mqtt');
    const installLib = require('../lib/install-lib.js');

    function resolveBinary(userPath) {
        if (userPath && userPath.trim() !== '') {
            return userPath.trim();
        }
        const found = installLib.findBinary();
        if (found) return found;
        return process.platform === 'win32' ? 'mosquitto.exe' : 'mosquitto';
    }

    function portInUse(port, host) {
        return new Promise((resolve) => {
            const tester = net.createServer()
                .once('error', (err) => {
                    resolve(err.code === 'EADDRINUSE');
                })
                .once('listening', () => {
                    tester.close(() => resolve(false));
                })
                .listen(port, host || '0.0.0.0');
        });
    }

    function MosquittoBrokerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const port = parseInt(config.port, 10) || 1883;
        const bind = (config.bind || '').trim();
        const allowAnonymous = config.allowAnonymous !== false;
        const persistence = !!config.persistence;
        const customConfigPath = (config.configPath || '').trim();
        let binaryPath = resolveBinary(config.binaryPath);
        const logToConsole = !!config.logToConsole;

        const username = (node.credentials && node.credentials.username) || '';
        const password = (node.credentials && node.credentials.password) || '';

        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-mosquitto-'));
        const generatedConfig = path.join(workDir, 'mosquitto.conf');
        const pwFile = path.join(workDir, 'passwd');
        const persistenceDir = path.join(workDir, 'data');

        let child = null;
        let stopping = false;
        let restartTimer = null;
        let mqttClient = null;
        const topics = new Map(); // topic -> { payload, timestamp, qos, retain }

        function bufferToView(buf) {
            // Try to expose the payload as a JS-friendly value. UTF-8
            // decode as a best-effort; keep the raw Buffer too.
            let string = null;
            try { string = buf.toString('utf8'); } catch (e) { /* binary */ }
            return { raw: buf, string };
        }

        function connectInternalClient() {
            if (mqttClient) return;
            const host = bind || '127.0.0.1';
            const url = `mqtt://${host}:${port}`;
            const opts = { reconnectPeriod: 2000, connectTimeout: 5000 };
            if (username && password) {
                opts.username = username;
                opts.password = password;
            }
            try {
                mqttClient = mqtt.connect(url, opts);
            } catch (err) {
                node.warn(`internal mqtt client failed to connect: ${err.message}`);
                return;
            }
            mqttClient.on('connect', () => {
                mqttClient.subscribe('#', { qos: 0 }, (err) => {
                    if (err) node.warn(`internal subscribe failed: ${err.message}`);
                });
            });
            mqttClient.on('message', (topic, payload, packet) => {
                topics.set(topic, {
                    payload: Buffer.from(payload),
                    timestamp: Date.now(),
                    qos: packet.qos,
                    retain: !!packet.retain
                });
            });
            mqttClient.on('error', (err) => {
                node.warn(`internal mqtt client error: ${err.message}`);
            });
        }

        function disconnectInternalClient() {
            if (!mqttClient) return;
            try { mqttClient.end(true); } catch (e) { /* ignore */ }
            mqttClient = null;
            topics.clear();
        }

        function cleanupWorkDir() {
            try {
                fs.rmSync(workDir, { recursive: true, force: true });
            } catch (e) {
                node.warn('Could not remove temp dir: ' + e.message);
            }
        }

        function writePasswordFile() {
            if (!username || !password) return null;
            // Plain format: mosquitto can read a plain user:password file when
            // `password_file` is combined with `allow_plain_passwords true`.
            // However, that option only exists on some builds. The portable
            // solution is to ask mosquitto_passwd to hash it. If that is not
            // available, fall back to plain format and warn the user.
            const plainContent = `${username}:${password}\n`;
            fs.writeFileSync(pwFile, plainContent, { mode: 0o600 });
            // Try to hash via mosquitto_passwd if available.
            try {
                const hasher = spawn('mosquitto_passwd', ['-U', pwFile]);
                return new Promise((resolve) => {
                    hasher.on('error', () => {
                        node.warn('mosquitto_passwd not found; password file left in plain format.');
                        resolve(pwFile);
                    });
                    hasher.on('exit', (code) => {
                        if (code !== 0) {
                            node.warn('mosquitto_passwd exited with code ' + code + '; password file may be unusable.');
                        }
                        resolve(pwFile);
                    });
                });
            } catch (e) {
                node.warn('Could not hash password file: ' + e.message);
                return pwFile;
            }
        }

        function buildConfig() {
            const lines = [];
            lines.push('# Auto-generated by node-red-contrib-mqtt-broker');
            if (bind) {
                lines.push(`listener ${port} ${bind}`);
            } else {
                lines.push(`listener ${port}`);
            }
            lines.push(`allow_anonymous ${allowAnonymous ? 'true' : 'false'}`);
            if (username && password) {
                lines.push(`password_file ${pwFile}`);
            }
            if (persistence) {
                fs.mkdirSync(persistenceDir, { recursive: true });
                lines.push('persistence true');
                lines.push(`persistence_location ${persistenceDir}${path.sep}`);
            } else {
                lines.push('persistence false');
            }
            lines.push('log_dest stdout');
            lines.push('log_type error');
            lines.push('log_type warning');
            lines.push('log_type notice');
            return lines.join('\n') + '\n';
        }

        function setStatus(fill, shape, text) {
            node.status({ fill, shape, text });
        }

        async function ensureBinaryAvailable() {
            // Skip the auto-install if the user pinned a custom binary -
            // they know what they want.
            if (config.binaryPath && config.binaryPath.trim() !== '') return true;
            if (installLib.findBinary()) return true;

            setStatus('blue', 'ring', 'installing mosquitto');
            node.warn('mosquitto binary not found; attempting auto-install. ' +
                'On Windows this may surface a UAC prompt.');

            const logger = {
                log:  (m) => node.log(m),
                warn: (m) => node.warn(m)
            };
            const res = await installLib.ensureInstalled({ logger });
            if (res.ok) {
                node.log(`mosquitto installed at ${res.path}`);
                // Refresh the resolved binary path now that it exists.
                binaryPath = resolveBinary(config.binaryPath);
                return true;
            }
            setStatus('red', 'ring', 'install failed');
            node.error('Auto-install of mosquitto failed. Send {"payload":"install"} ' +
                'to the node to retry, or install mosquitto manually and redeploy.');
            return false;
        }

        async function start() {
            if (child) return;

            try {
                if (!(await ensureBinaryAvailable())) return;

                const inUse = await portInUse(port, bind || '0.0.0.0');
                if (inUse) {
                    setStatus('red', 'ring', `port ${port} in use`);
                    node.error(`Port ${port} is already in use`);
                    return;
                }

                let configFileToUse;
                if (customConfigPath) {
                    if (!fs.existsSync(customConfigPath)) {
                        setStatus('red', 'ring', 'config not found');
                        node.error(`Config file not found: ${customConfigPath}`);
                        return;
                    }
                    configFileToUse = customConfigPath;
                } else {
                    if (username && password) {
                        await writePasswordFile();
                    }
                    fs.writeFileSync(generatedConfig, buildConfig(), { mode: 0o600 });
                    configFileToUse = generatedConfig;
                }

                setStatus('yellow', 'ring', 'starting');

                child = spawn(binaryPath, ['-c', configFileToUse], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                child.on('error', (err) => {
                    setStatus('red', 'ring', 'spawn error');
                    const hint = err.code === 'ENOENT'
                        ? ' - binary not found. Run "npm run install-mosquitto" in the module directory, or install mosquitto manually.'
                        : '';
                    node.error(`Failed to start mosquitto (${binaryPath}): ${err.message}${hint}`);
                    child = null;
                });

                child.stdout.on('data', (data) => {
                    const text = data.toString().trim();
                    if (logToConsole && text) node.log(text);
                    node.send({ topic: 'mosquitto/stdout', payload: text });
                });

                child.stderr.on('data', (data) => {
                    const text = data.toString().trim();
                    if (logToConsole && text) node.warn(text);
                    node.send({ topic: 'mosquitto/stderr', payload: text });
                });

                child.on('exit', (code, signal) => {
                    const wasRunning = child !== null;
                    child = null;
                    if (stopping) {
                        setStatus('grey', 'ring', 'stopped');
                        return;
                    }
                    const reason = signal ? `signal ${signal}` : `code ${code}`;
                    setStatus('red', 'ring', `exited (${reason})`);
                    node.warn(`mosquitto exited unexpectedly (${reason}); retrying in 5s`);
                    if (wasRunning && !restartTimer) {
                        restartTimer = setTimeout(() => {
                            restartTimer = null;
                            start();
                        }, 5000);
                    }
                });

                // Give the broker a moment to actually bind, then mark
                // running and attach the internal topic-tracking client.
                setTimeout(() => {
                    if (child) {
                        setStatus('green', 'dot', `running :${port}`);
                        connectInternalClient();
                    }
                }, 500);
            } catch (err) {
                setStatus('red', 'ring', 'start failed');
                node.error('Error starting broker: ' + err.message);
            }
        }

        function stop(done) {
            stopping = true;
            disconnectInternalClient();
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            if (!child) {
                cleanupWorkDir();
                if (done) done();
                return;
            }
            const proc = child;
            const killTimeout = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }, 5000);

            proc.once('exit', () => {
                clearTimeout(killTimeout);
                child = null;
                cleanupWorkDir();
                if (done) done();
            });

            try { proc.kill('SIGTERM'); } catch (e) {
                clearTimeout(killTimeout);
                cleanupWorkDir();
                if (done) done();
            }
        }

        node.on('input', (msg, send, doneCb) => {
            const cmd = (msg.payload && typeof msg.payload === 'object')
                ? msg.payload.command
                : msg.payload;
            if (cmd === 'start') {
                start().then(() => doneCb && doneCb());
                return;
            }
            if (cmd === 'stop') {
                stop(() => doneCb && doneCb());
                return;
            }
            if (cmd === 'restart') {
                stop(() => {
                    stopping = false;
                    start().then(() => doneCb && doneCb());
                });
                return;
            }
            if (cmd === 'status') {
                send({ topic: 'mosquitto/status', payload: {
                    running: !!child, port, bind, binary: binaryPath
                } });
                doneCb && doneCb();
                return;
            }
            if (cmd === 'install') {
                ensureBinaryAvailable().then((ok) => {
                    send({ topic: 'mosquitto/install', payload: {
                        ok, binary: ok ? binaryPath : null
                    } });
                    doneCb && doneCb();
                });
                return;
            }
            if (cmd === 'topics') {
                send({ topic: 'mosquitto/topics', payload: Array.from(topics.keys()).sort() });
                doneCb && doneCb();
                return;
            }
            if (cmd === 'get') {
                // Topic name: msg.payload.topic, or msg.topic when payload is just 'get'.
                const wanted = (msg.payload && typeof msg.payload === 'object' && msg.payload.topic)
                    || msg.topic
                    || '';
                if (!wanted) {
                    node.warn('get command needs a topic (msg.payload.topic or msg.topic)');
                    send({ topic: 'mosquitto/get', payload: { topic: null, found: false } });
                    doneCb && doneCb();
                    return;
                }
                const entry = topics.get(wanted);
                if (!entry) {
                    send({ topic: 'mosquitto/get', payload: { topic: wanted, found: false } });
                } else {
                    const view = bufferToView(entry.payload);
                    send({ topic: 'mosquitto/get', payload: {
                        topic: wanted,
                        found: true,
                        value: view.string,
                        buffer: view.raw,
                        qos: entry.qos,
                        retain: entry.retain,
                        timestamp: entry.timestamp
                    } });
                }
                doneCb && doneCb();
                return;
            }
            doneCb && doneCb();
        });

        node.on('close', (done) => {
            stop(done);
        });

        start();
    }

    RED.nodes.registerType('mqttbroker', MosquittoBrokerNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};
