/*
 * Reusable install + binary-resolution logic. Used by:
 *   - scripts/install-mosquitto.js (npm postinstall)
 *   - nodes/mosquitto-broker.js    (runtime self-heal on first deploy)
 *
 * Public API:
 *   findBinary()           -> absolute path or null
 *   ensureInstalled(opts)  -> async; returns { ok, path, log }
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const WIN_DEFAULT_VERSION = process.env.MOSQUITTO_WIN_VERSION || '2.0.20';

/* --------------------------- shared helpers --------------------------- */

function which(cmd) {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(probe, [cmd], { stdio: 'ignore' });
    return res.status === 0;
}

function isExecutable(p) {
    try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function canSudoNonInteractive() {
    if (isRoot()) return false;
    if (!which('sudo')) return false;
    return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
}

/* --------------------------- find existing --------------------------- */

function windowsCandidates() {
    const c = [];
    for (const env of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
        if (process.env[env]) c.push(path.join(process.env[env], 'mosquitto', 'mosquitto.exe'));
    }
    if (process.env.LOCALAPPDATA) {
        c.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'mosquitto', 'mosquitto.exe'));
        c.push(path.join(process.env.LOCALAPPDATA, 'mosquitto', 'mosquitto.exe'));
    }
    // Also check next to this module - lets us bundle a portable copy if ever needed.
    c.push(path.join(__dirname, '..', 'vendor', 'win32-x64', 'mosquitto.exe'));
    return c;
}

function findBinary() {
    if (process.platform === 'win32') {
        for (const c of windowsCandidates()) {
            if (isExecutable(c)) return c;
        }
        // PATH fallback via `where`.
        const r = spawnSync('where', ['mosquitto.exe'], { encoding: 'utf8' });
        if (r.status === 0) {
            const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (first) return first;
        }
        return null;
    }
    const r = spawnSync('which', ['mosquitto'], { encoding: 'utf8' });
    if (r.status === 0) {
        const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (first) return first;
    }
    return null;
}

/* --------------------------- winget lookup --------------------------- */

function findWingetExe() {
    if (which('winget')) return 'winget';
    // Common per-user locations when not on PATH (Node-RED Windows service
    // often inherits a stripped environment).
    const candidates = [];
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA,
            'Microsoft', 'WindowsApps', 'winget.exe'));
    }
    for (const c of candidates) {
        if (isExecutable(c)) return c;
    }
    return null;
}

/* ----------------------------- runners ------------------------------ */

function makeRun(logger) {
    return (cmd, args, opts) => {
        logger.log(`$ ${cmd} ${args.join(' ')}`);
        const res = spawnSync(cmd, args, Object.assign({
            stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
        }, opts || {}));
        if (res.stdout) res.stdout.split(/\r?\n/).filter(Boolean).forEach(l => logger.log(l));
        if (res.stderr) res.stderr.split(/\r?\n/).filter(Boolean).forEach(l => logger.warn(l));
        return res.status === 0;
    };
}

/* ----------------------------- Linux ------------------------------- */

function installLinux(logger, run) {
    const privileged = (cmd, args) => {
        if (isRoot()) return run(cmd, args);
        if (canSudoNonInteractive()) return run('sudo', ['-n', cmd, ...args]);
        logger.warn('Need root or passwordless sudo to install mosquitto.');
        return false;
    };

    const managers = [
        { name: 'apt-get', test: () => which('apt-get'), install: () => {
            if (!privileged('apt-get', ['update'])) {
                logger.warn('apt-get update returned non-zero; attempting install anyway.');
            }
            return privileged('apt-get', ['install', '-y', '--no-install-recommends',
                'mosquitto', 'mosquitto-clients']);
        }},
        { name: 'dnf', test: () => which('dnf'),
          install: () => privileged('dnf', ['install', '-y', 'mosquitto']) },
        { name: 'yum', test: () => which('yum'),
          install: () => privileged('yum', ['install', '-y', 'mosquitto']) },
        { name: 'zypper', test: () => which('zypper'),
          install: () => privileged('zypper', ['--non-interactive', 'install',
              'mosquitto', 'mosquitto-clients']) },
        { name: 'pacman', test: () => which('pacman'),
          install: () => privileged('pacman', ['-Sy', '--noconfirm', 'mosquitto']) },
        { name: 'apk', test: () => which('apk'),
          install: () => privileged('apk', ['add', '--no-cache',
              'mosquitto', 'mosquitto-clients']) }
    ];

    for (const m of managers) {
        if (m.test()) {
            logger.log(`Using ${m.name} ...`);
            return m.install();
        }
    }
    logger.warn('No supported Linux package manager found.');
    return false;
}

/* ----------------------------- macOS ------------------------------- */

function installMac(logger, run) {
    if (!which('brew')) {
        logger.warn('Homebrew not installed. See https://brew.sh/');
        return false;
    }
    return run('brew', ['install', 'mosquitto']);
}

/* ----------------------------- Windows ----------------------------- */

function installWindowsViaWinget(logger, run) {
    const winget = findWingetExe();
    if (!winget) return false;

    // Per-user scope first - no UAC prompt, works in non-interactive
    // contexts like a Node-RED palette install.
    logger.log('Trying winget per-user install ...');
    const userArgs = ['install', '--exact', '--id', 'EclipseFoundation.Mosquitto',
        '--scope', 'user',
        '--accept-source-agreements', '--accept-package-agreements',
        '--silent', '--disable-interactivity'];
    if (run(winget, userArgs)) return true;

    logger.log('Per-user install did not succeed; trying machine scope (may prompt UAC) ...');
    const sysArgs = ['install', '--exact', '--id', 'EclipseFoundation.Mosquitto',
        '--scope', 'machine',
        '--accept-source-agreements', '--accept-package-agreements',
        '--silent', '--disable-interactivity'];
    return run(winget, sysArgs);
}

function installWindowsViaChoco(logger, run) {
    if (!which('choco')) return false;
    logger.log('Using Chocolatey ...');
    return run('choco', ['install', 'mosquitto', '-y', '--no-progress']);
}

function downloadFile(url, destPath, redirects) {
    redirects = redirects || 0;
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        const req = https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(downloadFile(new URL(res.headers.location, url).toString(),
                    destPath, redirects + 1));
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
        req.setTimeout(180000, () => req.destroy(new Error('download timeout')));
    });
}

async function installWindowsViaDirectDownload(logger, run) {
    const arch = process.arch === 'x64' ? 'x64' : 'x32';
    const dir64 = arch === 'x64' ? 'win64' : 'win32';
    const file = `mosquitto-${WIN_DEFAULT_VERSION}-install-windows-${arch}.exe`;
    const url = `https://mosquitto.org/files/binary/${dir64}/${file}`;
    const tmp = path.join(os.tmpdir(), file);

    logger.log(`Downloading ${url}`);
    try {
        await downloadFile(url, tmp);
    } catch (err) {
        logger.warn(`Download failed: ${err.message}`);
        return false;
    }

    // /S = silent, NSIS will UAC-prompt if not elevated. The user sees
    // the prompt during a manual deploy, which is the realistic case.
    logger.log(`Running silent installer: ${tmp}`);
    const ok = run(tmp, ['/S']);
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return ok;
}

async function installWindows(logger, run) {
    if (installWindowsViaWinget(logger, run)) return true;
    if (installWindowsViaChoco(logger, run))  return true;
    logger.log('Falling back to direct installer download.');
    return installWindowsViaDirectDownload(logger, run);
}

/* ------------------------------ entry ------------------------------- */

async function ensureInstalled(opts) {
    opts = opts || {};
    const logger = opts.logger || {
        log:  (m) => process.stdout.write(`[mosquitto-broker] ${m}\n`),
        warn: (m) => process.stderr.write(`[mosquitto-broker] ${m}\n`)
    };
    const run = makeRun(logger);

    const existing = findBinary();
    if (existing) {
        logger.log(`mosquitto already present at ${existing}`);
        return { ok: true, path: existing };
    }

    logger.log('mosquitto not found, attempting install ...');

    let ok = false;
    try {
        switch (process.platform) {
            case 'linux':  ok = installLinux(logger, run); break;
            case 'darwin': ok = installMac(logger, run); break;
            case 'win32':  ok = await installWindows(logger, run); break;
            default:
                logger.warn(`Unsupported platform: ${process.platform}`);
        }
    } catch (err) {
        logger.warn(`Installer threw: ${err.message}`);
    }

    const after = findBinary();
    if (ok && after) {
        logger.log(`mosquitto installed at ${after}`);
        return { ok: true, path: after };
    }

    return { ok: false, path: null };
}

module.exports = { findBinary, ensureInstalled };
