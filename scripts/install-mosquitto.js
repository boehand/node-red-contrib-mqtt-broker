#!/usr/bin/env node
/*
 * npm postinstall: best-effort install of mosquitto. Never fails the
 * parent npm install. Real logic lives in lib/install-lib.js so the
 * runtime node can self-heal with the same code path.
 */
'use strict';

const SKIP_ENV = 'SKIP_MOSQUITTO_INSTALL';
const { ensureInstalled } = require('../lib/install-lib.js');

async function main() {
    if (process.env[SKIP_ENV] === '1') {
        process.stdout.write(`[mqtt-broker] ${SKIP_ENV}=1 set; skipping.\n`);
        return 0;
    }
    const res = await ensureInstalled();
    if (!res.ok) {
        process.stderr.write('[mqtt-broker] Could not install mosquitto automatically.\n');
        process.stderr.write('[mqtt-broker] The Node-RED node will retry on first deploy,\n');
        process.stderr.write('[mqtt-broker] which on Windows can surface a UAC prompt the\n');
        process.stderr.write('[mqtt-broker] non-interactive npm install could not.\n');
    }
    return 0;
}

main().then(c => process.exit(c)).catch((err) => {
    process.stderr.write(`[mqtt-broker] postinstall threw: ${err.message}\n`);
    process.exit(0);
});
