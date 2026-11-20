import fs from 'node:fs';

export const {version} = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repository = 'zonely-gen-tr/zonely-mcp';

export async function checkUpdate(fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'Zonely-MCP'}, redirect: 'error', signal: AbortSignal.timeout(7000),
  });
  if (response.status === 404) return {status: 'unpublished', current: version};
  if (!response.ok) throw Error('GitHub returned HTTP ' + response.status);
  const tag = (await response.json()).tag_name;
  const latest = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
  const stable = /^\d+\.\d+\.\d+$/;
  if (!stable.test(latest)) throw Error('No stable release version found');
  const currentParts = version.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);
  const difference = latestParts.map((part, index) => part - currentParts[index]).find(part => part !== 0) ?? 0;
  return difference > 0 ? {status: 'available', current: version, latest, url: `https://github.com/${repository}/releases/tag/${tag}`}
    : {status: 'current', current: version, latest};
}
