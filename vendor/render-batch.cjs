const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');
const { writeJSON: atomicWriteJSON } = require('./atomic-json.cjs');
sharp.concurrency(1);
sharp.cache(false);

const ROOT = __dirname;

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const textMetrics = new Map();
async function measureText(text, size, weight) {
  const key = JSON.stringify([text, size, weight]);
  if (!textMetrics.has(key)) {
    if (textMetrics.size >= 2000) textMetrics.delete(textMetrics.keys().next().value);
    textMetrics.set(key, sharp({ text: {
      text: escapeXml(text || ' '),
      font: `Segoe UI ${weight >= 600 ? 'Semi-Bold' : ''} ${size}`,
      dpi: 72, rgba: true,
    } }).metadata());
  }
  return textMetrics.get(key);
}

async function fitText(region, width, height, weight, availableWidth = width) {
   
  const original = await measureText(region.originalText, 16, weight);
  const base = Math.max(8, Math.round(16 * Math.min(
    width / Math.max(1, original.width), height / Math.max(1, original.height))));
  let size = base;
  const minSize = Math.max(8, Math.ceil(base * 0.9));
  while (size > minSize && (await measureText(region.text, size, weight)).width > availableWidth) size--;
  let text = String(region.text);
  if ((await measureText(text, size, weight)).width <= availableWidth) return { text, size, truncated: false };
  const chars = [...text.replace(/(?:\.{3}|\u2026)$/, '')];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await measureText(chars.slice(0, mid).join('') + '\u2026', size, weight)).width <= availableWidth) lo = mid;
    else hi = mid - 1;
  }
  return { text: chars.slice(0, lo).join('') + '\u2026', size, truncated: true };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function sampleBackground(pixels, bbox, imageW, imageH, channels) {
  const cx = Math.round((bbox.x0 + bbox.x1) / 2);
  const cy = Math.round((bbox.y0 + bbox.y1) / 2);
  const points = [
    [bbox.x0 - 3, cy], [bbox.x1 + 3, cy],
    [cx, bbox.y0 - 3], [cx, bbox.y1 + 3],
  ].map(([x, y]) => [clamp(x, 0, imageW - 1), clamp(y, 0, imageH - 1)]);
  const vals = [];
  for (const [x, y] of points) {
    const offset = (y * imageW + x) * channels;
    vals.push([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
  }
  const median = idx => vals.map(v => v[idx]).sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  return `rgb(${median(0)},${median(1)},${median(2)})`;
}

function availableRight(pixels, bbox, info, background) {
  const color = background.match(/\d+/g).map(Number);
  const top = clamp(Math.floor(bbox.y0), 0, info.height - 1);
  const bottom = clamp(Math.ceil(bbox.y1), top + 1, info.height);
  for (let x = Math.ceil(bbox.x1) + 3; x < info.width; x++) {
    for (let y = top; y < bottom; y++) {
      const offset = (y * info.width + x) * info.channels;
      if (color.some((value, channel) => Math.abs(pixels[offset + channel] - value) > 16)) {
        return Math.max(bbox.x1, x - 3);
      }
    }
  }
  return info.width - 2;
}

function sourceFor(cfg) {
  if (cfg.sourceFile && fs.existsSync(cfg.sourceFile)) return cfg.sourceFile;
  if (cfg.source && fs.existsSync(cfg.source)) return cfg.source;
  const rel = String(cfg.src || '').replace(/^\/+/, '');
  const fallback = path.join(ROOT, 'input', rel);
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(`Source image not found for ${cfg.src || 'unknown JSON'}`);
}

async function renderOne(jsonPath, outPath) {
  const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
  const source = sourceFor(cfg);
  const changed = (cfg.regions || []).filter(r => String(r.text ?? '') !== String(r.originalText ?? ''));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (!changed.length) {
    fs.copyFileSync(source, outPath);
    return { changed: 0 };
  }

   
  const { data: pixels, info } = await sharp(source)
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const patches = [];
  let truncated = 0;
  for (const r of changed) {
    const b = r.bbox;
    if (!b || !Number.isFinite(b.x0) || !Number.isFinite(b.y0) || !Number.isFinite(b.x1) || !Number.isFinite(b.y1)) continue;
    if ((r.confidence ?? 100) < 55 && String(r.originalText || '').trim().length <= 2) continue;
    const padX = 2;
    const padY = 1;
    const x = Math.max(0, b.x0 - padX);
    const y = Math.max(0, b.y0 - padY);
    const w = Math.max(6, b.x1 - b.x0 + padX * 2);
    const h = Math.max(10, b.y1 - b.y0 + padY * 2);
    const boxH = Math.max(1, b.y1 - b.y0);
    const bg = sampleBackground(pixels, b, info.width, info.height, info.channels);
    const rgb = bg.match(/\d+/g).map(Number);
    const textColor = (0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2]) > 145 ? '#111827' : '#f1f1f2';
     
     
    const right = availableRight(pixels, b, info, bg);
    const drawW = Math.min(right - x, cfg.image.width - x);
    const weight = boxH >= 13 ? 600 : 500;
    const fitted = await fitText(r, Math.max(1, b.x1 - b.x0), boxH, weight, Math.max(1, right - b.x0));
    if (fitted.truncated) truncated++;
    const fontSize = fitted.size;
    const metrics = await measureText(fitted.text, fontSize, weight);
    const baseline = b.y0 + (boxH + metrics.height) / 2;
    const clipId = `region-${patches.length}`;
    patches.push(`<defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${drawW}" height="${h}"/></clipPath></defs>` +
      `<rect x="${x}" y="${y}" width="${Math.min(w, cfg.image.width - x)}" height="${h}" rx="1" fill="${bg}"/>` +
      `<text clip-path="url(#${clipId})" x="${b.x0}" y="${baseline}" font-family="Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${textColor}">${escapeXml(fitted.text)}</text>`);
  }

  const svg = `<svg width="${cfg.image.width}" height="${cfg.image.height}" xmlns="http://www.w3.org/2000/svg">${patches.join('')}</svg>`;
  await sharp(source).composite([{ input: Buffer.from(svg) }])
    .png({ compressionLevel: 1, adaptiveFiltering: false }).toFile(outPath);
  return { changed: changed.length, truncated };
}

 
function renderVersion() {
  return crypto.createHash('sha256').update([
    renderOne, fitText, measureText, sampleBackground, availableRight, escapeXml, clamp,
  ].map(fn => fn.toString()).join('\n')).update(sharp.versions.sharp).digest('hex');
}
function renderKey(json, stat, version) {
  return crypto.createHash('sha256').update(json).update(version).update(`${stat.size}:${stat.mtimeMs}`).digest('hex');
}
function matchesRenderKey(saved, json, stat, current) {
  if (saved === current) return true;
   
   
  return false;
}

async function main() {
  const locale = process.argv[2] || 'en';
  const single = process.argv.find(a => a.startsWith('--single='));
  const dataRoot = path.join(ROOT, 'data', locale);
  const outputRoot = path.join(ROOT, 'output', locale, 'images');
  const workersArg = process.argv.find(a => a.startsWith('--workers='));
  const workers = Math.max(1, Math.min(4, Number(workersArg?.split('=')[1]) || 2));
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const noCache = single || process.argv.includes('--no-cache');
  let files = [];
  if (single) {
    files = [path.resolve(ROOT, single.split('=', 2)[1])];
  } else {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : (/\.json$/i.test(e.name) ? [p] : []);
    });
    files = walk(dataRoot);
  }

  if (limitArg) files = files.slice(0, Math.max(1, Number(limitArg.split('=')[1]) || 1));
  const statePath = path.join(ROOT, 'output', locale, '.render-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const version = renderVersion();
  let next = 0, done = 0, skipped = 0, changedRegions = 0, failed = 0;
  const saveState = () => {
    if (noCache) return;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state));
    fs.renameSync(statePath + '.tmp', statePath);
  };
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const rel = path.relative(dataRoot, file).replace(/\.json$/i, '.png');
      const out = single ? path.join(ROOT, 'output', locale, 'test', path.basename(rel)) : path.join(outputRoot, rel);
      try {
        const json = fs.readFileSync(file);
        const cfg = JSON.parse(json.toString('utf8').replace(/^\uFEFF/, ''));
        const stat = fs.statSync(sourceFor(cfg));
        const key = renderKey(json, stat, version);
        if (!noCache && matchesRenderKey(state[rel], json, stat, key) && fs.existsSync(out)) { skipped++; state[rel] = key; }
        else {
          const res = await renderOne(file, out);
          changedRegions += res.changed;
          state[rel] = key;
        }
      } catch (error) {
        failed++;
        console.error(`[${locale}] FAILED ${rel}: ${error.message}`);
      }
      done++;
      if (done % 25 === 0) saveState();
      if (done % 10 === 0 || done === files.length) {
        const pct = files.length ? (done * 100 / files.length).toFixed(2) : '100.00';
        console.log(`[${locale}] render ${pct}% [${done}/${files.length}] cached=${skipped} failed=${failed} changedRegions=${changedRegions}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, files.length) }, worker));
  saveState();
  if (failed) throw new Error(`${failed} image(s) failed to render`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
function createCachedRenderer(locale, onWarning = error => console.error(`Render cache: ${error.message}`)) {
  const dataRoot = path.join(ROOT, 'data', locale);
  const outputRoot = path.join(ROOT, 'output', locale, 'images');
  const statePath = path.join(ROOT, 'output', locale, '.render-state.json');
  const version = renderVersion();
  let state = {}, updates = 0, saving = Promise.resolve();
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const flush = () => {
    if (!updates) return saving;
    const snapshot = { ...state };
    updates = 0;
    saving = saving.then(() => atomicWriteJSON(statePath, snapshot)).catch(error => {
      updates++;
      onWarning(error, statePath);
    });
    return saving;
  };
  return {
    flush,
    async render(relative) {
      const jsonPath = path.resolve(dataRoot, relative);
      if (!jsonPath.startsWith(dataRoot + path.sep) || !/\.json$/i.test(jsonPath)) throw new Error('Gecersiz render JSON yolu');
      const rel = path.relative(dataRoot, jsonPath).replace(/\.json$/i, '.png');
      const out = path.join(outputRoot, rel);
      const json = fs.readFileSync(jsonPath);
      const cfg = JSON.parse(json.toString('utf8').replace(/^\uFEFF/, ''));
      if (cfg.translated !== true || cfg.translationMissing) throw new Error(`Eksik ceviri render edilmez: ${relative}`);
      const stat = fs.statSync(sourceFor(cfg));
      const key = renderKey(json, stat, version);
      if (matchesRenderKey(state[rel], json, stat, key) && fs.existsSync(out)) {
        if (state[rel] !== key) { state[rel] = key; updates++; }
        return { cached: true, changed: 0 };
      }
      const result = await renderOne(jsonPath, out);
      state[rel] = key;
      if (++updates >= 25) await flush();
      return { ...result, cached: false };
    },
  };
}

module.exports = { renderOne, createCachedRenderer, renderVersion, sharpVersion: sharp.versions.sharp };
