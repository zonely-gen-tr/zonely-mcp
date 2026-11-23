import fs from 'node:fs';

export const {version} = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const repository = 'zonely-gen-tr/zonely-mcp';
export const stableVersion = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;

export function compareVersions(left, right) {
  const current = right.split('.').map(Number);
  return left.split('.').map((part, index) => Number(part) - current[index]).find(part => part !== 0) ?? 0;
}

export async function latestRelease(fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'Zonely-MCP'}, redirect: 'error', signal: AbortSignal.timeout(7000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error('GitHub returned HTTP ' + response.status);
  const release = await response.json();
  const tag = release.tag_name;
  const latest = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
  if (!stableVersion.test(latest) || release.draft || release.prerelease) throw Error('No stable release version found');
  return {tag, latest, assets: Array.isArray(release.assets) ? release.assets : []};
}

export async function checkUpdate(fetcher = fetch) {
  const release = await latestRelease(fetcher);
  if (!release) return {status: 'unpublished', current: version};
  const {tag, latest} = release;
  return compareVersions(latest, version) > 0 ? {status: 'available', current: version, latest, url: `https://github.com/${repository}/releases/tag/${tag}`}
    : {status: 'current', current: version, latest};
}
