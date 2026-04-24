module.exports = function (RED) {
    'use strict';

    const { spawn } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const net = require('net');
    const mqtt = require('mqtt');
    const installLib = require('../lib/install-lib.js');

    function resolveBinary(userPath, scope) {
        if (userPath && userPath.trim() !== '') {
            return userPath.trim();
        }
        const found = installLib.findBinary({ scope: scope || 'any' });
        if (found) return found;
        return process.platform === 'win32' ? 'mosquitto.exe' : 'mosquitto';
    }

    function defaultPersistenceBase() {
        const userDir = (RED.settings && RED.settings.userDir)
            || path.join(os.homedir(), '.node-red');
        return path.join(userDir, 'mqtt-broker-persistence');
    }

    function defaultPersistenceDirFor(nodeId) {
        return path.join(defaultPersistenceBase(), nodeId || 'default');
    }

    // Editor helper: lets the HTML side render the actual default path in
    // the persistence-path placeholder instead of a vague "temp dir" hint.
    RED.httpAdmin.get('/mqttbroker/defaults',
        RED.auth.needsPermission('mqttbroker.read'),
        (req, res) => {
            res.json({
                persistenceBase: defaultPersistenceBase(),
                platform: process.platform
            });
        });

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
        const persistenceLocation = (config.persistenceLocation || '').trim();
        const customConfigPath = (config.configPath || '').trim();
        const installScope = (config.installScope || 'auto').trim();
        let binaryPath = resolveBinary(config.binaryPath, installScope);
        const logToConsole = !!config.logToConsole;
        const logToTerminal = !!config.logToTerminal;

        const updateCheckEnabled = config.updateCheckEnabled !== false;
        const rawInterval = parseInt(config.updateCheckInterval, 10);
        const updateCheckIntervalMin = (rawInterval && rawInterval > 0) ? rawInterval : 15;

        const username = (node.credentials && node.credentials.username) || '';
        const password = (node.credentials && node.credentials.password) || '';

        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-mosquitto-'));
        const generatedConfig = path.join(workDir, 'mosquitto.conf');
        const pwFile = path.join(workDir, 'passwd');
        // Persistence default lives under userDir so data survives redeploys
        // and Node-RED restarts - otherwise "Persistence" would only cover
        // the lifetime of this node instance, which defeats the point.
        const defaultPersistenceDir = defaultPersistenceDirFor(node.id);

        let child = null;
        let stopping = false;
        let restartTimer = null;
        let mqttClient = null;
        let updateTimer = null;
        let initialUpdateTimer = null;
        let lastUpdateInfo = null;
        const topics = new Map();

        function bufferToView(buf) {
            let string = null;
            try { string = buf.toString('utf8'); } catch (e) { /* binary */ }
            return { raw: buf, string };
        }

        function effectivePersistenceDir() {
            // User-supplied path wins; fall back to a tmp dir under workDir.
            return persistenceLocation || defaultPersistenceDir;
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
            const plainContent = `${username}:${password}\n`;
            fs.writeFileSync(pwFile, plainContent, { mode: 0o600 });
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
                const dir = effectivePersistenceDir();
                try {
                    fs.mkdirSync(dir, { recursive: true });
                } catch (err) {
                    node.warn(`Could not create persistence dir ${dir}: ${err.message}`);
                }
                lines.push('persistence true');
                const sep = dir.endsWith(path.sep) ? '' : path.sep;
                lines.push(`persistence_location ${dir}${sep}`);
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

        async function ensureBinaryAvailable(opts) {
            opts = opts || {};
            const scope = opts.scope || installScope;
            const force = !!opts.force;

            // Skip the auto-install if the user pinned a custom binary.
            if (!force && config.binaryPath && config.binaryPath.trim() !== '') {
                return { ok: true, path: config.binaryPath.trim(), scope: 'custom',
                    alreadyInstalled: true };
            }
            if (!force) {
                const existing = installLib.findBinary({
                    scope: scope === 'auto' ? 'any' : scope
                });
                if (existing) {
                    binaryPath = resolveBinary(config.binaryPath, scope);
                    return { ok: true, path: existing,
                        scope: existing.startsWith(installLib.VENDOR_DIR) ? 'local' : 'global',
                        alreadyInstalled: true };
                }
            }

            setStatus('blue', 'ring', force ? 'updating mosquitto' : 'installing mosquitto');
            node.warn(force
                ? `Installing mosquitto update (scope=${scope}) ...`
                : `mosquitto binary not found; attempting install (scope=${scope}). ` +
                  'On Windows this may surface a UAC prompt.');

            const logger = {
                log:  (m) => node.log(m),
                warn: (m) => node.warn(m)
            };
            const res = await installLib.ensureInstalled({ logger, scope, force });
            if (res.ok) {
                node.log(`mosquitto ready at ${res.path} (scope=${res.scope})`);
                binaryPath = resolveBinary(config.binaryPath, scope);
                return res;
            }
            setStatus('red', 'ring', 'install failed');
            node.error('Auto-install of mosquitto failed. Send {"payload":"install"} ' +
                'to the node to retry, or install mosquitto manually and redeploy.');
            return res;
        }

        async function start() {
            if (child) return;

            try {
                const ensured = await ensureBinaryAvailable();
                if (!ensured.ok) return;

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

                // Locally-installed mosquitto on Linux ships its shared libs
                // under VENDOR_DIR/usr/lib; teach the child process how to
                // find them.
                const spawnEnv = Object.assign({}, process.env);
                if (ensured.scope === 'local' && process.platform === 'linux') {
                    const libDirs = [
                        path.join(installLib.VENDOR_DIR, 'usr', 'lib',
                            `${process.arch === 'x64' ? 'x86_64' : process.arch}-linux-gnu`),
                        path.join(installLib.VENDOR_DIR, 'usr', 'lib'),
                        path.join(installLib.VENDOR_DIR, 'lib')
                    ].filter(d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
                    if (libDirs.length) {
                        spawnEnv.LD_LIBRARY_PATH = [
                            ...libDirs,
                            spawnEnv.LD_LIBRARY_PATH || ''
                        ].filter(Boolean).join(path.delimiter);
                    }
                }

                child = spawn(binaryPath, ['-c', configFileToUse], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: spawnEnv
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
                    if (text && logToConsole) {
                        // node.warn is what users perceive as "Node-RED
                        // console": it is written to the server log AND to
                        // the Debug sidebar. node.log only reaches the
                        // server log, which many users never see.
                        node.warn('[mosquitto] ' + text);
                    }
                    if (text && logToTerminal) {
                        // Direct write to the real stdout - bypasses the
                        // Node-RED logger level so it also appears when
                        // Node-RED is launched in a terminal without any
                        // logger config.
                        process.stdout.write('[mosquitto] ' + text + '\n');
                    }
                    node.send({ topic: 'mosquitto/stdout', payload: text });
                });

                child.stderr.on('data', (data) => {
                    const text = data.toString().trim();
                    if (text && logToConsole) node.warn('[mosquitto] ' + text);
                    if (text && logToTerminal) {
                        process.stderr.write('[mosquitto] ' + text + '\n');
                    }
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

                setTimeout(() => {
                    if (child) {
                        setStatus('green', 'dot', `running :${port}`);
                        connectInternalClient();
                    }
                }, 500);

                scheduleUpdateChecks();
            } catch (err) {
                setStatus('red', 'ring', 'start failed');
                node.error('Error starting broker: ' + err.message);
            }
        }

        function stop(done) {
            stopping = true;
            disconnectInternalClient();
            cancelUpdateChecks();
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

        /* ---------------------- update checking ---------------------- */

        async function runUpdateCheck(silent) {
            try {
                const info = await installLib.checkForUpdate(binaryPath);
                lastUpdateInfo = Object.assign({ checkedAt: Date.now() }, info);
                if (!silent || info.updateAvailable) {
                    node.send({ topic: 'mosquitto/update', payload: lastUpdateInfo });
                }
                if (info.updateAvailable) {
                    node.log(`mosquitto update available: ${info.installed} -> ${info.latest}. ` +
                        'Send {"payload":"update"} to install.');
                }
                return lastUpdateInfo;
            } catch (err) {
                node.warn(`update check failed: ${err.message}`);
                return { error: err.message };
            }
        }

        function scheduleUpdateChecks() {
            cancelUpdateChecks();
            if (!updateCheckEnabled) return;
            // First check shortly after start so the UI becomes informative
            // without waiting for the full interval to elapse.
            initialUpdateTimer = setTimeout(() => {
                initialUpdateTimer = null;
                runUpdateCheck(true);
            }, 10000);
            const intervalMs = updateCheckIntervalMin * 60 * 1000;
            updateTimer = setInterval(() => runUpdateCheck(true), intervalMs);
        }

        function cancelUpdateChecks() {
            if (initialUpdateTimer) {
                clearTimeout(initialUpdateTimer);
                initialUpdateTimer = null;
            }
            if (updateTimer) {
                clearInterval(updateTimer);
                updateTimer = null;
            }
        }

        async function performUpdate(send) {
            // Re-check before installing so we don't force-reinstall when
            // the node's cached view is stale.
            const info = await runUpdateCheck(true);
            if (!info || !info.updateAvailable) {
                send({ topic: 'mosquitto/update', payload: Object.assign(
                    { installed: info && info.installed, latest: info && info.latest,
                      updateAvailable: false, updated: false,
                      message: 'no update available' })
                });
                return;
            }
            const wasRunning = !!child;
            if (wasRunning) {
                await new Promise((resolve) => stop(resolve));
                stopping = false;
            }
            const res = await ensureBinaryAvailable({ force: true, scope: installScope });
            const newVersion = res.ok ? installLib.getInstalledVersion(binaryPath) : null;
            send({ topic: 'mosquitto/update', payload: {
                installed: newVersion,
                latest: info.latest,
                updateAvailable: !!(newVersion && info.latest &&
                    installLib.compareVersions(newVersion, info.latest) < 0),
                updated: !!res.ok,
                scope: res.scope,
                path: res.path
            } });
            if (wasRunning) {
                await start();
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
                    running: !!child,
                    port,
                    bind,
                    binary: binaryPath,
                    scope: installScope,
                    persistence,
                    persistenceLocation: persistence ? effectivePersistenceDir() : null,
                    updateCheckEnabled,
                    updateCheckIntervalMin,
                    lastUpdateInfo
                } });
                doneCb && doneCb();
                return;
            }
            if (cmd === 'install') {
                const scopeArg = (msg.payload && typeof msg.payload === 'object'
                    && msg.payload.scope) || installScope;
                ensureBinaryAvailable({ scope: scopeArg }).then((res) => {
                    send({ topic: 'mosquitto/install', payload: {
                        ok: !!res.ok,
                        binary: res.ok ? binaryPath : null,
                        scope: res.scope,
                        alreadyInstalled: !!res.alreadyInstalled
                    } });
                    doneCb && doneCb();
                });
                return;
            }
            if (cmd === 'check-update') {
                runUpdateCheck(false).then(() => doneCb && doneCb());
                return;
            }
            if (cmd === 'update') {
                performUpdate(send).then(() => doneCb && doneCb());
                return;
            }
            if (cmd === 'topics') {
                send({ topic: 'mosquitto/topics', payload: Array.from(topics.keys()).sort() });
                doneCb && doneCb();
                return;
            }
            if (cmd === 'get') {
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
