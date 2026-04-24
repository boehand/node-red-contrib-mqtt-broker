/*
 * Reusable install + binary-resolution logic. Used by:
 *   - scripts/install-mosquitto.js (npm postinstall)
 *   - nodes/mqttbroker.js          (runtime self-heal on first deploy)
 *
 * Public API:
 *   findBinary(opts?)       -> absolute path or null (opts.scope: 'any'|'local'|'global')
 *   ensureInstalled(opts)   -> async; { ok, path, scope, alreadyInstalled }
 *   getInstalledVersion(p)  -> '2.0.20' or null
 *   getLatestVersion()      -> async; '2.0.20' or null
 *   compareVersions(a, b)   -> -1 | 0 | 1
 *   checkForUpdate(p)       -> async; { installed, latest, updateAvailable }
 *   VENDOR_DIR              -> absolute path to the module's per-platform vendor dir
 *   MODULE_ROOT             -> absolute path to the module root
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const WIN_DEFAULT_VERSION = process.env.MOSQUITTO_WIN_VERSION || '2.0.20';

const MODULE_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(MODULE_ROOT, 'vendor',
    `${process.platform}-${process.arch}`);

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

function localBinaryCandidates() {
    // Layout depends on how the package was extracted/installed:
    // - Linux:  dpkg-deb -x drops /usr/sbin/mosquitto into VENDOR_DIR
    // - Win32:  NSIS /D=VENDOR_DIR lands mosquitto.exe at the root
    // - macOS:  (best-effort) same as Linux layout
    const exe = process.platform === 'win32' ? 'mosquitto.exe' : 'mosquitto';
    return [
        path.join(VENDOR_DIR, exe),
        path.join(VENDOR_DIR, 'usr', 'sbin', exe),
        path.join(VENDOR_DIR, 'usr', 'bin', exe),
        path.join(VENDOR_DIR, 'bin', exe),
        path.join(VENDOR_DIR, 'sbin', exe),
        // Legacy location kept for compatibility with older vendored builds.
        path.join(MODULE_ROOT, 'vendor', 'win32-x64', 'mosquitto.exe')
    ];
}

function findLocalBinary() {
    for (const c of localBinaryCandidates()) {
        if (isExecutable(c)) return c;
    }
    return null;
}

function windowsSystemCandidates() {
    const c = [];
    for (const env of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
        if (process.env[env]) c.push(path.join(process.env[env], 'mosquitto', 'mosquitto.exe'));
    }
    if (process.env.LOCALAPPDATA) {
        c.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'mosquitto', 'mosquitto.exe'));
        c.push(path.join(process.env.LOCALAPPDATA, 'mosquitto', 'mosquitto.exe'));
    }
    return c;
}

function findGlobalBinary() {
    if (process.platform === 'win32') {
        for (const c of windowsSystemCandidates()) {
            if (isExecutable(c)) return c;
        }
        const r = spawnSync('where', ['mosquitto.exe'], { encoding: 'utf8' });
        if (r.status === 0) {
            const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
            // Make sure a hit inside our own vendor dir isn't reported as "global".
            if (first && !first.toLowerCase().startsWith(VENDOR_DIR.toLowerCase())) {
                return first;
            }
        }
        return null;
    }
    const r = spawnSync('which', ['mosquitto'], { encoding: 'utf8' });
    if (r.status === 0) {
        const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (first && !first.startsWith(VENDOR_DIR)) return first;
    }
    return null;
}

function findBinary(opts) {
    const scope = (opts && opts.scope) || 'any';
    if (scope === 'local') return findLocalBinary();
    if (scope === 'global') return findGlobalBinary();
    // 'any': prefer a local install so scope=local users aren't shadowed by
    // a system binary that happens to be on PATH.
    return findLocalBinary() || findGlobalBinary();
}

/* --------------------------- winget lookup --------------------------- */

function findWingetExe() {
    if (which('winget')) return 'winget';
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

function installLinuxGlobal(logger, run) {
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
            logger.log(`Using ${m.name} (global scope) ...`);
            return m.install();
        }
    }
    logger.warn('No supported Linux package manager found.');
    return false;
}

function installLinuxLocal(logger, run) {
    // Best-effort local install: use apt-get to download the .deb packages
    // without root, then extract them into VENDOR_DIR with dpkg-deb.
    if (!which('apt-get') || !which('dpkg-deb')) {
        logger.warn('Local install on Linux currently requires apt-get + dpkg-deb.');
        return false;
    }
    try {
        fs.mkdirSync(VENDOR_DIR, { recursive: true });
    } catch (err) {
        logger.warn(`Could not create ${VENDOR_DIR}: ${err.message}`);
        return false;
    }

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-mosquitto-dl-'));
    try {
        logger.log(`Downloading mosquitto .deb packages into ${downloadDir} ...`);
        const dl = run('apt-get', ['download', 'mosquitto', 'libmosquitto1'],
            { cwd: downloadDir });
        if (!dl) {
            logger.warn('apt-get download failed; local install not possible.');
            return false;
        }
        const debs = fs.readdirSync(downloadDir).filter(f => f.endsWith('.deb'));
        if (!debs.length) {
            logger.warn('No .deb files produced by apt-get download.');
            return false;
        }
        for (const deb of debs) {
            logger.log(`Extracting ${deb} -> ${VENDOR_DIR}`);
            if (!run('dpkg-deb', ['-x', path.join(downloadDir, deb), VENDOR_DIR])) {
                logger.warn(`dpkg-deb extraction failed for ${deb}`);
                return false;
            }
        }
    } finally {
        try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}
    }
    const found = findLocalBinary();
    if (!found) {
        logger.warn('Extraction finished but no mosquitto binary landed in the vendor dir.');
        return false;
    }
    try { fs.chmodSync(found, 0o755); } catch (_) {}
    return true;
}

/* ----------------------------- macOS ------------------------------- */

function installMacGlobal(logger, run) {
    if (!which('brew')) {
        logger.warn('Homebrew not installed. See https://brew.sh/');
        return false;
    }
    return run('brew', ['install', 'mosquitto']);
}

function installMacLocal(logger) {
    // No first-class local-install story on macOS - brew does not support
    // a per-module prefix cleanly. Document the limitation and bail.
    logger.warn('Local-scope install is not supported on macOS; ' +
        'falling back to global scope would require "brew install mosquitto".');
    return false;
}

/* ----------------------------- Windows ----------------------------- */

function installWindowsViaWinget(logger, run) {
    const winget = findWingetExe();
    if (!winget) return false;

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

async function installWindowsViaDirectDownload(logger, run, targetDir) {
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

    // NSIS: /S silent, /D=<dir> per-instance install directory. /D MUST be
    // the final argument and MUST NOT be quoted even when the path has
    // spaces - that is an NSIS quirk, not a bug on our side.
    const args = ['/S'];
    if (targetDir) {
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (_) {}
        args.push(`/D=${targetDir}`);
    }
    logger.log(`Running silent installer: ${tmp} ${args.join(' ')}`);
    const ok = run(tmp, args);
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return ok;
}

async function installWindowsGlobal(logger, run) {
    if (installWindowsViaWinget(logger, run)) return true;
    if (installWindowsViaChoco(logger, run))  return true;
    logger.log('Falling back to direct installer download.');
    return installWindowsViaDirectDownload(logger, run);
}

async function installWindowsLocal(logger, run) {
    // winget/choco always target machine-wide paths, so the only reliable
    // per-module install is the NSIS installer with /D=VENDOR_DIR.
    logger.log('Installing mosquitto locally into the module vendor directory ...');
    return installWindowsViaDirectDownload(logger, run, VENDOR_DIR);
}

/* --------------------------- version helpers ------------------------- */

function getInstalledVersion(binaryPath) {
    if (!binaryPath) return null;
    try {
        const res = spawnSync(binaryPath, ['-h'],
            { encoding: 'utf8', timeout: 5000 });
        const out = `${res.stdout || ''}\n${res.stderr || ''}`;
        const m = out.match(/mosquitto version (\d+\.\d+\.\d+)/i);
        return m ? m[1] : null;
    } catch (_) {
        return null;
    }
}

function httpsGetJson(url, redirects) {
    redirects = redirects || 0;
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        const parsed = new URL(url);
        const req = https.get({
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: {
                'User-Agent': 'node-red-contrib-mqtt-broker',
                'Accept': 'application/vnd.github+json'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(httpsGetJson(new URL(res.headers.location, url).toString(),
                    redirects + 1));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (err) { reject(err); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    });
}

async function getLatestVersion() {
    const data = await httpsGetJson(
        'https://api.github.com/repos/eclipse/mosquitto/releases/latest');
    const tag = (data && data.tag_name) || '';
    const m = tag.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

function compareVersions(a, b) {
    if (!a || !b) return 0;
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
}

async function checkForUpdate(binaryPath) {
    const installed = getInstalledVersion(binaryPath);
    let latest = null;
    let error = null;
    try {
        latest = await getLatestVersion();
    } catch (err) {
        error = err.message;
    }
    const updateAvailable = !!(installed && latest &&
        compareVersions(installed, latest) < 0);
    return { installed, latest, updateAvailable, error };
}

/* ------------------------------ entry ------------------------------- */

async function ensureInstalled(opts) {
    opts = opts || {};
    const logger = opts.logger || {
        log:  (m) => process.stdout.write(`[mqtt-broker] ${m}\n`),
        warn: (m) => process.stderr.write(`[mqtt-broker] ${m}\n`)
    };
    const scope = opts.scope || 'auto';
    const force = !!opts.force;
    const run = makeRun(logger);

    // Duplicate-avoidance: by default, re-use whatever is already present.
    if (!force) {
        if (scope === 'local') {
            const existing = findLocalBinary();
            if (existing) {
                logger.log(`mosquitto already present (local) at ${existing}`);
                const global = findGlobalBinary();
                if (global) {
                    logger.log(`Note: a global mosquitto also exists at ${global}; ` +
                        'the local copy will be used by this node.');
                }
                return { ok: true, path: existing, scope: 'local',
                    alreadyInstalled: true };
            }
        } else if (scope === 'global') {
            const existing = findGlobalBinary();
            if (existing) {
                logger.log(`mosquitto already present (global) at ${existing}`);
                return { ok: true, path: existing, scope: 'global',
                    alreadyInstalled: true };
            }
        } else {
            const existing = findBinary();
            if (existing) {
                logger.log(`mosquitto already present at ${existing}`);
                return { ok: true, path: existing,
                    scope: existing.startsWith(VENDOR_DIR) ? 'local' : 'global',
                    alreadyInstalled: true };
            }
        }
    }

    logger.log(`mosquitto install requested (scope=${scope}${force ? ', force=true' : ''}) ...`);

    let ok = false;
    try {
        if (scope === 'local') {
            switch (process.platform) {
                case 'linux':  ok = installLinuxLocal(logger, run); break;
                case 'darwin': ok = installMacLocal(logger); break;
                case 'win32':  ok = await installWindowsLocal(logger, run); break;
                default:
                    logger.warn(`Unsupported platform for local install: ${process.platform}`);
            }
        } else {
            // scope 'global' and 'auto' share the global install path.
            switch (process.platform) {
                case 'linux':  ok = installLinuxGlobal(logger, run); break;
                case 'darwin': ok = installMacGlobal(logger, run); break;
                case 'win32':  ok = await installWindowsGlobal(logger, run); break;
                default:
                    logger.warn(`Unsupported platform: ${process.platform}`);
            }
        }
    } catch (err) {
        logger.warn(`Installer threw: ${err.message}`);
    }

    const after = scope === 'local' ? findLocalBinary()
        : scope === 'global' ? findGlobalBinary()
        : findBinary();

    if (ok && after) {
        logger.log(`mosquitto installed at ${after}`);
        const resolvedScope = after.startsWith(VENDOR_DIR) ? 'local' : 'global';
        return { ok: true, path: after, scope: resolvedScope,
            alreadyInstalled: false };
    }

    return { ok: false, path: null, scope: null, alreadyInstalled: false };
}

module.exports = {
    findBinary,
    findLocalBinary,
    findGlobalBinary,
    ensureInstalled,
    getInstalledVersion,
    getLatestVersion,
    compareVersions,
    checkForUpdate,
    MODULE_ROOT,
    VENDOR_DIR
};
