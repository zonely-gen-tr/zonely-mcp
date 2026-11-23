import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';

const maxArchive = 16 * 1024 * 1024;
const maxExtracted = 32 * 1024 * 1024;
const archiveRoot = 'Zonely-MCP/';
const rootFiles = new Set(['.gitignore', 'AGENTS.md', 'LICENSE', 'README.md', 'SETUP.tr.md',
  'package.json', 'package-lock.json', 'requirements.txt']);
const rootDirectories = new Set(['src', 'data', 'vendor', 'scripts', 'assets']);
const repositories = new Set(['https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);
const unsafeWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

async function fetchAsset(url, fetcher) {
  const signal = AbortSignal.timeout(45000);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (!repositories.has(url.origin) || url.username || url.password) throw Error('Untrusted release download address');
    const response = await fetcher(url, {redirect: 'manual', signal, headers: {'User-Agent': 'Zonely-MCP'}});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw Error('Incomplete release redirect');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw Error('Release download failed');
    return response.body;
  }
  throw Error('Too many release redirects');
}

export async function downloadArchive(asset, expectedUrl, fetcher = fetch) {
  if (asset.browser_download_url !== expectedUrl || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') ||
      !Number.isSafeInteger(asset.size) || asset.size < 22 || asset.size > maxArchive) {
    throw Error('Release has no verifiable ZIP');
  }
  const body = await fetchAsset(new URL(expectedUrl), fetcher);
  const chunks = [];
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > asset.size) throw Error('Release download exceeded its declared size');
    chunks.push(chunk);
    hash.update(chunk);
  }
  if (size !== asset.size || 'sha256:' + hash.digest('hex') !== asset.digest.toLowerCase()) {
    throw Error('Release ZIP digest mismatch');
  }
  return Buffer.concat(chunks, size);
}

function archiveEntry(entry) {
  const {fileName, externalFileAttributes} = entry;
  if (fileName === archiveRoot) return null;
  if (!fileName.startsWith(archiveRoot)) throw Error('Unexpected release ZIP root');
  const directory = fileName.endsWith('/');
  const parts = fileName.slice(archiveRoot.length, directory ? -1 : undefined).split('/');
  if (parts.some(part => {
    if (parts.length === 1 && part === '.gitignore') return false;
    return !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || part.endsWith('.') || unsafeWindowsName.test(part);
  })) {
    throw Error('Unsafe ZIP entry name');
  }
  const kind = (externalFileAttributes >>> 16) & 0o170000;
  if (kind !== 0 && kind !== (directory ? 0o040000 : 0o100000)) throw Error('Unsupported ZIP entry type');
  if (parts.length === 1 ? !(directory ? rootDirectories : rootFiles).has(parts[0]) : !rootDirectories.has(parts[0])) {
    throw Error('Unexpected file in release ZIP');
  }
  return {parts, directory};
}

export async function unpackArchive(buffer, destination) {
  const {fromBuffer} = (await import('yauzl')).default;
  const zip = await new Promise((resolve, reject) => fromBuffer(buffer, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
  }, (error, value) => error ? reject(error) : resolve(value)));
  const seen = new Set();
  let expanded = 0;
  try {
    if (zip.entryCount > 512) throw Error('Release ZIP contains too many files');
    await new Promise((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        void (async () => {
          const item = archiveEntry(entry);
          if (!item) return;
          const key = item.parts.join('/').toLowerCase();
          expanded += entry.uncompressedSize;
          if (seen.has(key) || expanded > maxExtracted) throw Error('Invalid release ZIP contents');
          seen.add(key);
          const output = path.join(destination, ...item.parts);
          await fsp.mkdir(item.directory ? output : path.dirname(output), {recursive: true});
          if (item.directory) return;
          const stream = await new Promise((accept, fail) =>
            zip.openReadStream(entry, (error, value) => error ? fail(error) : accept(value)));
          await pipeline(stream, fs.createWriteStream(output, {flags: 'wx', mode: 0o600}));
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
