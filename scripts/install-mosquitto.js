#!/usr/bin/env node
/*
 * Best-effort installer for the `mosquitto` broker (and the
 * `mosquitto_passwd` helper from `mosquitto-clients`). Runs as a
 * post-install step so the Node-RED node has its native dependency
 * available on first deploy.
 *
 * Design rules:
 *  - Never fail the parent `npm install`: always exit 0.
 *  - Never prompt: use non-interactive flags, never open a password prompt.
 *  - Never touch the system without privileges: if not root and `sudo`
 *    is missing (or `sudo -n` refuses), log instructions and give up.
 *  - Skip entirely if SKIP_MOSQUITTO_INSTALL=1 or if mosquitto is already
 *    on PATH.
 */
'use strict';

const { spawnSync } = require('child_process');
const os = require('os');

const SKIP_ENV = 'SKIP_MOSQUITTO_INSTALL';

function log(msg) {
    process.stdout.write(`[mosquitto-broker] ${msg}\n`);
}

function warn(msg) {
    process.stderr.write(`[mosquitto-broker] ${msg}\n`);
}

function which(cmd) {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(probe, [cmd], { stdio: 'ignore' });
    return res.status === 0;
}

function run(cmd, args, opts) {
    log(`$ ${cmd} ${args.join(' ')}`);
    const res = spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
    return res.status === 0;
}

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function canSudoNonInteractive() {
    if (isRoot()) return false;
    if (!which('sudo')) return false;
    const res = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
    return res.status === 0;
}

function privileged(cmd, args) {
    if (isRoot()) {
        return run(cmd, args);
    }
    if (canSudoNonInteractive()) {
        return run('sudo', ['-n', cmd, ...args]);
    }
    warn('Need root privileges to install mosquitto, and no passwordless sudo is available.');
    return false;
}

function installLinux() {
    const managers = [
        {
            name: 'apt-get',
            test: () => which('apt-get'),
            install: () => privileged('apt-get', ['update']) &&
                privileged('apt-get', ['install', '-y', '--no-install-recommends', 'mosquitto', 'mosquitto-clients'])
        },
        {
            name: 'dnf',
            test: () => which('dnf'),
            install: () => privileged('dnf', ['install', '-y', 'mosquitto'])
        },
        {
            name: 'yum',
            test: () => which('yum'),
            install: () => privileged('yum', ['install', '-y', 'mosquitto'])
        },
        {
            name: 'zypper',
            test: () => which('zypper'),
            install: () => privileged('zypper', ['--non-interactive', 'install', 'mosquitto', 'mosquitto-clients'])
        },
        {
            name: 'pacman',
            test: () => which('pacman'),
            install: () => privileged('pacman', ['-Sy', '--noconfirm', 'mosquitto'])
        },
        {
            name: 'apk',
            test: () => which('apk'),
            install: () => privileged('apk', ['add', '--no-cache', 'mosquitto', 'mosquitto-clients'])
        }
    ];

    for (const mgr of managers) {
        if (mgr.test()) {
            log(`Using ${mgr.name} to install mosquitto...`);
            if (mgr.install()) {
                return true;
            }
            warn(`${mgr.name} install failed.`);
            return false;
        }
    }
    warn('No supported package manager found (apt-get, dnf, yum, zypper, pacman, apk).');
    return false;
}

function installMac() {
    if (!which('brew')) {
        warn('Homebrew (brew) is not installed. Install it from https://brew.sh/ then run:');
        warn('  brew install mosquitto');
        return false;
    }
    return run('brew', ['install', 'mosquitto']);
}

function installWindows() {
    warn('Automatic installation on Windows is not supported.');
    warn('Download the Mosquitto installer from https://mosquitto.org/download/');
    warn('and make sure mosquitto.exe is on your PATH.');
    return false;
}

function main() {
    if (process.env[SKIP_ENV] === '1') {
        log(`${SKIP_ENV}=1 set; skipping mosquitto auto-install.`);
        return 0;
    }

    if (which('mosquitto')) {
        log('mosquitto already installed, skipping.');
        return 0;
    }

    log('mosquitto not found on PATH, attempting automatic install...');

    let ok = false;
    try {
        switch (process.platform) {
            case 'linux':   ok = installLinux();   break;
            case 'darwin':  ok = installMac();     break;
            case 'win32':   ok = installWindows(); break;
            default:
                warn(`Unsupported platform: ${process.platform}. Install mosquitto manually.`);
        }
    } catch (err) {
        warn(`Installer threw: ${err.message}`);
    }

    if (ok && which('mosquitto')) {
        log('mosquitto installed successfully.');
    } else {
        warn('Could not install mosquitto automatically.');
        warn(`Set ${SKIP_ENV}=1 to silence this, or install mosquitto yourself.`);
        warn('The Node-RED node will still install; it will report the error at deploy time.');
    }
    return 0; // never fail npm install
}

process.exit(main());
