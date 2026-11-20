import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const settingsDirectory = () => path.resolve(process.env.ZONELY_CONFIG_DIR ?? path.join(os.homedir(), '.zonely-mcp'));
export const settingsPath = () => path.join(settingsDirectory(), 'connection.json');

export function config() {
  const file = settingsPath();
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const connection = settings.connection ?? null;
  const origin = connection?.panel?.url ?? connection?.api?.url;
  const binding = origin ? createHash('sha256').update(origin).digest('hex').slice(0, 24) : 'unconfigured';
  const runtime = path.join(settingsDirectory(), 'sites', binding);
  return {
    base, runtime, connection, apiCredential: settings.apiCredential,
    accountDirectory: path.join(settingsDirectory(), 'account-provisioning'),
    python: process.env.ZONELY_PYTHON ?? settings.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
    imports: path.join(runtime, 'imports'), media: path.join(runtime, 'media'),
    worker: path.join(base, 'src', 'worker.py'), workerLog: path.join(runtime, 'worker.log'),
  };
}
