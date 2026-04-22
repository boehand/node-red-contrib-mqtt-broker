/*
 * Runs the Node-RED node outside of Node-RED, long-lived, so the demo
 * script can hit its broker with mosquitto_pub / mosquitto_sub. Exits
 * cleanly on SIGTERM so the GIF ends on a clean shutdown line.
 */
'use strict';

const nodeFactory = require('../nodes/mosquitto-broker.js');

const PORT = 18840;

function decorate(target, config) {
    target.config = config;
    target.credentials = {};
    target._handlers = {};
    target.on    = (ev, fn) => (target._handlers[ev] = target._handlers[ev] || []).push(fn);
    target.emit  = (ev, ...a) => (target._handlers[ev] || []).forEach(f => f(...a));
    target.send  = () => {};
    target.status = (s) => process.stdout.write(`[node status] ${s.fill}  ${s.text}\n`);
    target.log   = (m) => process.stdout.write(`[node log] ${m}\n`);
    target.warn  = (m) => process.stderr.write(`[node warn] ${m}\n`);
    target.error = (m) => process.stderr.write(`[node err]  ${m}\n`);
}

const RED = {
    nodes: {
        createNode(n, cfg) { decorate(n, cfg); },
        registerType(name, ctor) { RED._ctors = (RED._ctors || {}); RED._ctors[name] = ctor; }
    }
};

nodeFactory(RED);
const Ctor = RED._ctors['mosquitto-broker'];

const node = {};
Ctor.call(node, {
    port: PORT,
    bind: '127.0.0.1',
    allowAnonymous: true,
    persistence: false,
    binaryPath: '',
    configPath: '',
    logToConsole: false,
    credentials: {}
});

function shutdown() {
    process.stdout.write('[demo] shutting down broker...\n');
    node.emit('close', () => {
        process.stdout.write('[demo] broker stopped.\n');
        process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Expose the node for send-command.js via IPC file.
const fs = require('fs');
fs.writeFileSync('/tmp/demo-broker.pid', String(process.pid));
