import { version } from './version.mjs';

const receiver = 'https://accounts.zonely.gen.tr/Files/Api/mcp-diagnostics.php';
const delay = 45000;
const duplicateWindow = 15 * 60 * 1000;
const dailyLimit = 24;
const jobTools = new Map([
  ['panel.setup.batch', 'zonely_panel_setup_batch'], ['store.setup', 'zonely_store_setup'],
  ['content.localize', 'zonely_localize'], ['media.ocr', 'zonely_media_ocr'], ['media.localize', 'zonely_media_localize'],
]);
const stageCodes = new Map([
  ['admin_route_missing', 'admin_route_missing'],
  ['admin_integration_incomplete', 'admin_integration_incomplete'],
  ['admin_verification_unavailable', 'verification_failed'],
  ['apply_incomplete', 'apply_incomplete'],
  ['readback_missing', 'verification_failed'],
  ['readback_unavailable', 'verification_failed'],
  ['upload_admission_rejected', 'upload_rejected'],
  ['upload_rejected', 'upload_rejected'],
  ['cloud_upload_failed', 'upload_rejected'],
  ['workspace_unavailable', 'panel_unavailable'],
  ['outcome_unknown', 'unconfirmed'],
  ['rejected', 'apply_rejected'],
  ['unconfirmed', 'unconfirmed'],
  ['failed', 'operation_failed'],
]);

function outcomeCode(result) {
  return stageCodes.get(result?.stage) ?? stageCodes.get(result?.status) ??
    stageCodes.get(result?.admin?.stage) ?? (result?.done === false && result?.failedStep ? 'operation_failed' : null);
}

function errorCode(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/site sign-in is required|signed-in session required/i.test(message)) return 'sign_in_required';
  if (/timed?\s*out|timeout/i.test(message) || error?.name === 'TimeoutError') return 'timeout';
  if (/\bsftp\b|template import failed/i.test(message)) return 'theme_sync_failed';
  if (/revision conflict|template changed before/i.test(message)) return 'revision_conflict';
  if (/did not render|homepage is unavailable|health check failed/i.test(message)) return 'render_failed';
  if (/panel session could not be started|panel page could not be opened/i.test(message)) return 'panel_unavailable';
  return 'operation_failed';
}

export function createDiagnostics({ enabled = process.env.ZONELY_DIAGNOSTICS === '1', fetcher = fetch, now = Date.now } = {}) {
  const seen = new Map();
  let day = -1;
  let sent = 0;
  let inFlight = 0;

  function report(tool, code) {
    if (!enabled || typeof tool !== 'string' || !/^zonely_[a-z_]{1,52}$/.test(tool)) return;
    const timestamp = now();
    const today = Math.floor(timestamp / 86400000);
    if (today !== day) { day = today; sent = 0; }
    if (sent >= dailyLimit || inFlight >= 2) return;
    for (const [key, time] of seen) if (timestamp - time >= duplicateWindow) seen.delete(key);
    const key = `${tool}:${code}`;
    if (seen.has(key)) return;
    seen.set(key, timestamp);
    sent++;
    inFlight++;
    void Promise.resolve().then(() => fetcher(receiver, {
      method:'POST', headers:{'Content-Type':'application/json'}, redirect:'error',
      signal:AbortSignal.timeout(3500), body:JSON.stringify({ schema:1, version, tool, code }),
    })).then(response => response.body?.cancel()).catch(() => {}).finally(() => { inFlight--; });
  }

  async function observe(tool, operation) {
    if (!enabled) return operation();
    const watchdog = setTimeout(() => report(tool, 'slow_operation'), delay);
    watchdog.unref();
    try {
      const result = await operation();
      const code = outcomeCode(result);
      if (code) report(tool, code);
      return result;
    } catch (error) {
      report(tool, errorCode(error));
      throw error;
    } finally { clearTimeout(watchdog); }
  }
  return {
    enabled,
    updateFailed() { report('zonely_check_update', 'update_failed'); },
    observe,
    observeJob(kind, operation) { return observe(jobTools.get(kind) ?? 'zonely_job', operation); },
  };
}
