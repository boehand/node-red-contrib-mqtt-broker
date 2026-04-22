#!/usr/bin/env node
/*
 * Best-effort installer for the `mosquitto` broker (and the
 * `mosquitto_passwd` helper). Runs as a post-install step so the
 * Node-RED node has its native dependency available on first deploy.
 *
 * Linux : apt-get / dnf / yum / zypper / pacman / apk
 * macOS : Homebrew
 * Win32 : winget -> chocolatey -> direct silent installer download
 *
 * Design rules:
 *  - Never fail the parent `npm install`: always exit 0.
 *  - Never prompt: use non-interactive flags.
 *  - Never touch the system without privileges. On Linux, require root
 *    or passwordless sudo; otherwise log instructions and give up.
 *  - Skip entirely if SKIP_MOSQUITTO_INSTALL=1 or if mosquitto is
 *    already on PATH / in a known install location.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const SKIP_ENV = 'SKIP_MOSQUITTO_INSTALL';

// Pinned fallback version used if neither winget nor chocolatey is
// available on Windows. Override with MOSQUITTO_WIN_VERSION.
const WIN_DEFAULT_VERSION = process.env.MOSQUITTO_WIN_VERSION || '2.0.20';

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

/* ------------------------------- Linux ------------------------------- */

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

/* ------------------------------- macOS ------------------------------- */

function installMac() {
    if (!which('brew')) {
        warn('Homebrew (brew) is not installed. Install it from https://brew.sh/ then run:');
        warn('  brew install mosquitto');
        return false;
    }
    return run('brew', ['install', 'mosquitto']);
}

/* ------------------------------ Windows ------------------------------ */

function windowsInstallDirs() {
    const candidates = [];
    if (process.env['ProgramFiles']) {
        candidates.push(path.join(process.env['ProgramFiles'], 'mosquitto'));
    }
    if (process.env['ProgramFiles(x86)']) {
        candidates.push(path.join(process.env['ProgramFiles(x86)'], 'mosquitto'));
    }
    return candidates;
}

function findWindowsBinary() {
    for (const dir of windowsInstallDirs()) {
        const exe = path.join(dir, 'mosquitto.exe');
        try {
            if (fs.existsSync(exe)) return exe;
        } catch (e) { /* ignore */ }
    }
    return null;
}

function installWindowsViaWinget() {
    if (!which('winget')) return false;
    log('Using winget to install mosquitto...');
    return run('winget', [
        'install', '--exact', '--id', 'EclipseFoundation.Mosquitto',
        '--accept-source-agreements', '--accept-package-agreements',
        '--silent', '--disable-interactivity'
    ]);
}

function installWindowsViaChoco() {
    if (!which('choco')) return false;
    log('Using Chocolatey to install mosquitto...');
    return run('choco', ['install', 'mosquitto', '-y', '--no-progress']);
}

function downloadFile(url, destPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error('too many redirects'));
        const req = https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                resolve(downloadFile(next, destPath, redirectCount + 1));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
            file.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
    });
}

async function installWindowsViaDirectDownload() {
    const arch = process.arch === 'x64' ? 'x64' : 'x32';
    const version = WIN_DEFAULT_VERSION;
    const fileName = `mosquitto-${version}-install-windows-${arch}.exe`;
    const url = `https://mosquitto.org/files/binary/win${arch === 'x64' ? '64' : '32'}/${fileName}`;
    const tmpFile = path.join(os.tmpdir(), fileName);

    log(`Downloading ${url}`);
    try {
        await downloadFile(url, tmpFile);
    } catch (err) {
        warn(`Download failed: ${err.message}`);
        return false;
    }

    log(`Running silent installer: ${tmpFile}`);
    // NSIS silent install. Requires admin privileges; if the current
    // shell is not elevated, Windows will surface a UAC prompt or the
    // install will fail. We ask it to exit immediately either way.
    const ok = run(tmpFile, ['/S']);
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    return ok;
}

async function installWindows() {
    if (findWindowsBinary()) {
        log(`mosquitto already present at ${findWindowsBinary()}`);
        return true;
    }

    if (installWindowsViaWinget()) return true;
    if (installWindowsViaChoco())  return true;

    log('Neither winget nor Chocolatey available; trying direct installer download...');
    if (await installWindowsViaDirectDownload()) return true;

    warn('Automatic installation on Windows failed.');
    warn('Install Mosquitto manually from https://mosquitto.org/download/');
    warn('and make sure mosquitto.exe is on PATH or in "Program Files\\mosquitto".');
    return false;
}

/* ------------------------------- main ------------------------------- */

function brokerInstalled() {
    if (which('mosquitto')) return true;
    if (process.platform === 'win32' && findWindowsBinary()) return true;
    return false;
}

async function main() {
    if (process.env[SKIP_ENV] === '1') {
        log(`${SKIP_ENV}=1 set; skipping mosquitto auto-install.`);
        return 0;
    }

    if (brokerInstalled()) {
        log('mosquitto already installed, skipping.');
        return 0;
    }

    log('mosquitto not found, attempting automatic install...');

    let ok = false;
    try {
        switch (process.platform) {
            case 'linux':   ok = installLinux();         break;
            case 'darwin':  ok = installMac();           break;
            case 'win32':   ok = await installWindows(); break;
            default:
                warn(`Unsupported platform: ${process.platform}. Install mosquitto manually.`);
        }
    } catch (err) {
        warn(`Installer threw: ${err.message}`);
    }

    if (ok && brokerInstalled()) {
        log('mosquitto installed successfully.');
    } else {
        warn('Could not install mosquitto automatically.');
        warn(`Set ${SKIP_ENV}=1 to silence this, or install mosquitto yourself.`);
        warn('The Node-RED node will still install; it will report the error at deploy time.');
    }
    return 0; // never fail npm install
}

main().then((code) => process.exit(code)).catch((err) => {
    warn(`Unexpected installer failure: ${err && err.message ? err.message : err}`);
    process.exit(0);
});
