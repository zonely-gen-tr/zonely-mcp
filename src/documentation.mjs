import fs from 'node:fs';

const origin = 'https://docs.zonely.gen.tr';
const languages = JSON.parse(fs.readFileSync(new URL('../data/documentation-languages.json', import.meta.url), 'utf8'));
const maxBytes = 256 * 1024;
const cacheLifetime = 60 * 60 * 1000;

export function documentationLanguages() {
  return Object.entries(languages).map(([code, {name}]) => ({code, name}));
}

export function documentationLanguage(value = 'tr') {
  const requested = value.trim().replace('_', '-').toLowerCase();
  const code = Object.keys(languages).find(language => language.toLowerCase() === requested);
  if (!code) throw Error('Choose a documentation language: ' + Object.keys(languages).join(', '));
  return code;
}

export function documentationGuide(guide, language) {
  const translation = languages[language].guides[guide.url];
  const prefix = languages[language].prefix;
  const url = (prefix ? '/' + prefix : '') + guide.url;
  return {...guide, ...(translation ?? {}), url, guidePath: guide.url,
    documentationUrl: origin + url, language};
}

function withoutIndex(markdown) {
  return markdown.replace(/^>\s*## Documentation Index\r?\n(?:>[^\n]*\n)*\r?\n?/,'').trim();
}

async function readMarkdown(fetcher, url, language) {
  const response = await fetcher(url, {
    headers: {Accept: 'text/markdown', 'Accept-Language': language},
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !/^text\/markdown\b/i.test(response.headers.get('content-type') ?? '')
    || Number(response.headers.get('content-length') ?? 0) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw Error('Documentation Markdown unavailable');
  }
  const reader = response.body.getReader();
  const content = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Error('Documentation Markdown exceeds the size limit');
      content.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const markdown = withoutIndex(Buffer.concat(content).toString('utf8'));
  if (!markdown) throw Error('Documentation Markdown is empty');
  return markdown;
}

export class DocumentationReader {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
    this.cache = new Map();
  }

  async open(guide, language, offset = 0) {
    if (!/^(?:\/[a-z0-9-]+)+$/.test(guide.url)) throw Error('Choose a known documentation guide');
    const localized = documentationGuide(guide, language);
    const markdownUrl = localized.documentationUrl + '.md';
    const cached = this.cache.get(markdownUrl);
    let markdown = cached?.markdown;
    let source = 'cache';
    let contentLanguage = language;
    if (!cached || cached.expires < Date.now()) {
      try {
        markdown = await readMarkdown(this.fetcher, markdownUrl, language);
        this.cache.set(markdownUrl, {markdown, expires: Date.now() + cacheLifetime});
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
        source = 'live';
      } catch {
        if (cached) {
          source = 'stale-cache';
        } else {
          contentLanguage = localized.description ? language : 'tr';
          markdown = localized.description ? '# ' + localized.title + '\n\n' + localized.description
            : [guide.title, guide.excerpt, ...(guide.headings ?? [])].filter(Boolean).join('\n\n');
          source = 'bundled-summary';
        }
      }
    }
    const excerpt = markdown.slice(offset, offset + 5000);
    return {guidePath: guide.url, url: localized.documentationUrl, markdownUrl, language, contentLanguage,
      source, offset, nextOffset: offset + excerpt.length < markdown.length ? offset + excerpt.length : null,
      documentationText: excerpt};
  }
}
