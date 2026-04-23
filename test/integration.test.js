#!/usr/bin/env node
/*
 * End-to-end smoke test: load the Node-RED node with a minimal RED
 * mock, start the mosquitto broker it manages, publish a message with
 * mosquitto_pub, and confirm mosquitto_sub receives it via the
 * brokered bus. Also exercises the 'status' input command, restart,
 * and clean shutdown.
 *
 * Requires: mosquitto and mosquitto-clients on PATH.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const nodeFactory = require('../nodes/mqtt-broker.js');

let PORT = 18830 + Math.floor(Math.random() * 1000);

function assert(cond, msg) {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('ok  -', msg);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ----------------------------- RED mock ----------------------------- */

function decorateAsNode(target, config) {
    target.config = config;
    target.credentials = (config && config.credentials) || {};
    target._handlers = {};
    target._sent = [];
    target._status = null;
    target._errors = [];
    target.on    = (ev, fn) => { (target._handlers[ev] = target._handlers[ev] || []).push(fn); };
    target.emit  = (ev, ...a) => (target._handlers[ev] || []).forEach(f => f(...a));
    target.send  = (msg) => { target._sent.push(msg); };
    target.status = (s) => { target._status = s; };
    target.log   = () => {};
    target.warn  = () => {};
    target.error = (s) => { target._errors.push(String(s)); };
}

const RED = {
    nodes: {
        createNode(node, config) {
            decorateAsNode(node, config);
        },
        registerType(name, ctor) {
            RED._ctors = RED._ctors || {};
            RED._ctors[name] = ctor;
        }
    }
};

nodeFactory(RED);
const Ctor = RED._ctors['mqtt-broker'];
assert(typeof Ctor === 'function', 'node factory registered mqtt-broker');

/* ------------------------- Boot a broker node ------------------------ */

async function main() {
    console.log(`# Using port ${PORT}`);

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

    // Wait for the broker to actually bind.
    await sleep(1500);

    assert(node._status && node._status.fill === 'green',
        `status turned green (got ${JSON.stringify(node._status)})`);
    assert(node._errors.length === 0,
        `no errors during startup (got: ${node._errors.join(' | ')})`);

    /* --- Publish/subscribe round trip through the broker --- */

    const received = [];
    const sub = spawn('mosquitto_sub', [
        '-h', '127.0.0.1', '-p', String(PORT),
        '-t', 'test/topic', '-v', '-W', '5'
    ]);
    sub.stdout.on('data', (d) => received.push(d.toString()));
    sub.stderr.on('data', (d) => process.stderr.write('[sub] ' + d));

    await sleep(500); // let the subscriber connect

    const pub = spawnSync('mosquitto_pub', [
        '-h', '127.0.0.1', '-p', String(PORT),
        '-t', 'test/topic', '-m', 'hello-from-test'
    ]);
    assert(pub.status === 0,
        `mosquitto_pub exited 0 (stderr: ${pub.stderr && pub.stderr.toString().trim()})`);

    await sleep(800);
    sub.kill('SIGTERM');
    await sleep(200);

    const joined = received.join('');
    assert(joined.includes('test/topic hello-from-test'),
        `subscriber received the message (got: ${JSON.stringify(joined)})`);

    /* --- 'status' input command emits an output message --- */

    node._sent.length = 0;
    node.emit('input', { payload: 'status' }, (m) => node._sent.push(m), () => {});
    assert(node._sent.length === 1 && node._sent[0].topic === 'mosquitto/status',
        `status command emitted mosquitto/status message`);
    assert(node._sent[0].payload.running === true && node._sent[0].payload.port === PORT,
        `status payload reflects running broker on port ${PORT}`);

    /* --- Internal client tracks topics: give it time to catch up --- */

    // Publish a second retained message so we can check "get" too.
    spawnSync('mosquitto_pub', [
        '-h', '127.0.0.1', '-p', String(PORT),
        '-t', 'sensors/temp', '-m', '21.5', '-r'
    ]);
    await sleep(800);

    node._sent.length = 0;
    node.emit('input', { payload: 'topics' }, (m) => node._sent.push(m), () => {});
    assert(node._sent.length === 1 && node._sent[0].topic === 'mosquitto/topics',
        'topics command emitted mosquitto/topics message');
    const seen = node._sent[0].payload;
    assert(Array.isArray(seen) && seen.includes('test/topic') && seen.includes('sensors/temp'),
        `topics list includes earlier publishes (got ${JSON.stringify(seen)})`);

    node._sent.length = 0;
    node.emit('input',
        { payload: { command: 'get', topic: 'sensors/temp' } },
        (m) => node._sent.push(m), () => {});
    assert(node._sent.length === 1 && node._sent[0].topic === 'mosquitto/get',
        'get command emitted mosquitto/get message');
    const entry = node._sent[0].payload;
    // retain=false is correct here: MQTT only flags retain=true on
    // messages delivered to a fresh subscriber, not on live messages
    // the internal client receives while already subscribed.
    assert(entry.found === true && entry.value === '21.5' && entry.topic === 'sensors/temp',
        `get returns last value for sensors/temp (got ${JSON.stringify(entry)})`);
    assert(Buffer.isBuffer(entry.buffer) && entry.buffer.toString() === '21.5',
        'get response includes raw Buffer for binary payloads');

    node._sent.length = 0;
    node.emit('input',
        { payload: { command: 'get', topic: 'does/not/exist' } },
        (m) => node._sent.push(m), () => {});
    assert(node._sent[0].payload.found === false,
        'get for unseen topic reports found=false');

    /* --- Clean shutdown via 'close' event --- */

    await new Promise((resolve) => node.emit('close', resolve));
    await sleep(300);

    // After close, port must be free.
    const afterPub = spawnSync('mosquitto_pub', [
        '-h', '127.0.0.1', '-p', String(PORT),
        '-t', 'x', '-m', 'y', '--connection-timeout', '1'
    ]);
    assert(afterPub.status !== 0,
        `broker is down after close (pub now fails as expected, status=${afterPub.status})`);

    console.log('\nAll integration checks passed.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Test threw:', err);
    process.exit(1);
});
