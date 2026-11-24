import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {settingsDirectory} from './config.mjs';
import {compareVersions, latestRelease, repository, stableVersion, version} from './version.mjs';
import {downloadArchive, unpackArchive} from './update-archive.mjs';

const checkInterval = 6 * 60 * 60 * 1000;
const maxInstallTime = 5 * 60 * 1000;
const root = () => path.join(settingsDirectory(), 'updates');
const packageInfo = new URL('../package.json', import.meta.url);
export const automaticUpdatesEnabled = () => process.env.ZONELY_AUTO_UPDATE !== '0';

export function installedUpdate(current = version, directory = root()) {
  let versions;
  try {
    versions = fs.readdirSync(directory, {withFileTypes: true})
      .filter(entry => entry.isDirectory() && stableVersion.test(entry.name))
      .map(entry => entry.name)
      .filter(candidate => compareVersions(candidate, current) > 0)
      .sort((a, b) => compareVersions(b, a));
  } catch { return null; }
  for (const version of versions) {
    const location = path.join(directory, version);
    const launcher = path.join(location, 'src', 'cli.mjs');
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(location, '.zonely-ready.json'), 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
      if (marker.version === version && manifest.version === version && manifest.name === '@zonely/mcp' &&
          fs.lstatSync(launcher).isFile()) return {version, launcher};
    } catch { continue; }
  }
  return null;
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env, windowsHide: true, stdio: 'ignore', timeout: maxInstallTime});
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('Release setup failed')));
  });
}

async function prepareRelease(directory, wanted) {
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fsp.readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  if (manifest.name !== '@zonely/mcp' || manifest.version !== wanted || lock.name !== manifest.name ||
      lock.version !== wanted || lock.packages?.['']?.version !== wanted) {
    throw Error('Release package identity mismatch');
  }
  for (const entry of Object.values(lock.packages)) {
    if (!entry.resolved) continue;
    if (new URL(entry.resolved).origin !== 'https://registry.npmjs.org' ||
        !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? '')) {
      throw Error('Release dependency is outside the pinned registry');
    }
  }
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const options = ['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org'];
  const env = {...process.env, npm_config_engine_strict: 'true'};
  delete env.ZONELY_SITE_API_KEY;
  if (fs.existsSync(npm)) await run(process.execPath, [npm, ...options], directory, env);
  else if (process.platform !== 'win32') await run('npm', options, directory, env);
  else throw Error('Node.js npm launcher is unavailable');
  await run(process.execPath, ['--input-type=module', '-e', "await import('./src/server.mjs')"], directory, env);
  const previous = JSON.parse(await fsp.readFile(packageInfo, 'utf8'));
  if (previous.dependencies.playwright !== manifest.dependencies.playwright) {
    await run(process.execPath, ['src/cli.mjs', 'install-browser'], directory, env);
  }
}

async function checkAndPrepare(directory, current, fetcher, prepare) {
  await fsp.mkdir(directory, {recursive: true, mode: 0o700});
  const lockPath = path.join(directory, 'check.lock');
  let lock;
  try {
    lock = await fsp.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const updated = await fsp.stat(lockPath).then(info => info.mtimeMs, () => Date.now());
      if (updated < Date.now() - 6 * maxInstallTime) {
        await fsp.unlink(lockPath).catch(() => {});
      }
      return null;
    }
    throw error;
  }
  let stage;
  try {
    const pending = installedUpdate(current, directory);
    if (pending) return pending;
    const release = await latestRelease(fetcher);
    if (!release || compareVersions(release.latest, current) <= 0) return null;
    const file = 'Zonely-MCP-' + release.latest + '.zip';
    const asset = release.assets.find(item => item.name === file && item.state === 'uploaded');
    if (!asset) return null;
    const url = 'https://github.com/' + repository + '/releases/download/' + release.tag + '/' + file;
    const buffer = await downloadArchive(asset, url, fetcher);
    stage = await fsp.mkdtemp(path.join(directory, '.stage-'));
    await unpackArchive(buffer, stage);
    await prepare(stage, release.latest);
    await fsp.writeFile(path.join(stage, '.zonely-ready.json'), JSON.stringify({version: release.latest}), {mode: 0o600, flag: 'wx'});
    await fsp.rename(stage, path.join(directory, release.latest));
    stage = null;
    return installedUpdate(current, directory);
  } finally {
    if (stage) await fsp.rm(stage, {recursive: true, force: true}).catch(() => {});
    await lock.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

export function createAutoUpdater({directory = root(), current = version, fetcher = fetch,
  prepare = prepareRelease, now = Date.now, onFailure = () => {}} = {}) {
  let nextCheck = 0;
  let ready;
  return {
    onRequest() {
      if (!automaticUpdatesEnabled() || ready || now() < nextCheck) return;
      nextCheck = now() + checkInterval;
      void checkAndPrepare(directory, current, fetcher, prepare)
        .then(update => { if (update) ready = update.version; })
        .catch(() => { onFailure(); });
    },
    status() {
      return ready ? {status: 'ready-on-reconnect', version: ready} : undefined;
    },
  };
}
