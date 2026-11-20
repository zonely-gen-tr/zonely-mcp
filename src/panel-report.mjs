import {matchesPost} from './panel-request.mjs';

const endpoint = '/Files/Controllers/ControllersAll.php';
const reportsPage = 'panel:site:page:main.reports';
const reportDrawer = 'panel:site:drawer:report_update';
const decisions = {APPROVED: '1', REJECTED: '0'};

function controller(origin, container) {
  const url = new URL(endpoint, origin);
  url.search = new URLSearchParams({main:'Reports', container});
  return url;
}

async function readReport(page, origin, recordId) {
  const url = controller(origin, 'ReportsDetailController');
  url.searchParams.set('report_id', String(recordId));
  return page.evaluate(async ({url, recordId}) => {
    const response = await fetch(url, {credentials:'same-origin', redirect:'error', cache:'no-store',
      headers:{'X-Requested-With':'XMLHttpRequest', Accept:'application/json'}, signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('Report details are unavailable');
    const result = await response.json();
    const report = result.data?.report;
    if (result.status !== 'success' || Number(report?.id) !== recordId ||
      !['PENDING','APPROVED','REJECTED'].includes(report.status)) throw Error('Could not verify the selected report');
    return {recordId, status:report.status, reason:String(report.resolved_reason ?? '')};
  }, {url:url.href, recordId});
}

export async function runReportDecision(panel, {recordId, fields, files, envFields, mode}) {
  if (!Number.isSafeInteger(recordId) || recordId <= 0) throw Error('Select a report ID');
  const {status, reason, expectedStatus} = fields;
  if (files.length || envFields.length || Object.keys(fields).some(name=>!['status','reason','expectedStatus'].includes(name)))
    throw Error('Use status, reason and expectedStatus for this workflow');
  const note = typeof reason === 'string' ? reason.replace(/\r\n?/gu,'\n').trim() : '';
  if (mode === 'apply' && (typeof status !== 'string' || !Object.hasOwn(decisions,status) ||
    !note || [...note].length > 1024)) throw Error('Provide APPROVED or REJECTED and a reason up to 1024 characters');

  const origin = panel.origin();
  const page = await panel.navigate(reportsPage);
  const before = await readReport(page, origin, recordId);
  if (mode === 'apply') {
    if (before.status !== expectedStatus) throw Error('Use the current report status returned by preview');
    if (before.status === status && before.reason === note)
      return {submitted:false, verified:true, report:before};
  }
  await panel.mountDrawer(reportDrawer, recordId, true);
  await page.locator('#reportDecisionBtn').click();
  const dialog = page.locator('.swal2-popup');
  await dialog.locator('#swalReportStatus').waitFor({state:'visible'});
  if (mode === 'preview') return {ready:true, submitted:false, report:before};
  await dialog.locator('#swalReportStatus').selectOption(decisions[status]);
  await dialog.locator('#swalReportReason').fill(note);
  const expected = controller(origin, 'ReportsUpdateStatusController');
  const body = {report_id:String(recordId), status:decisions[status], content:note};
  panel.expectedPost = expected;
  panel.expectedPostBody = body;
  panel.expectedPostFields = Object.keys(body);
  panel.allowWrites = true;
  const waiting = page.waitForResponse(response=>matchesPost(response.request(),expected,body),{timeout:10000}).catch(()=>null);
  try {
    await dialog.locator('.swal2-confirm').click();
    const response = await waiting;
    panel.allowWrites = false;
    if (!response) throw Error('Report result is unknown. Read its current status before retrying.');
    if (!response.ok()) throw Error('The panel rejected the report decision');
    const after = await readReport(page, origin, recordId);
    return {submitted:true, verified:after.status===status&&after.reason===note, report:after};
  } finally {
    panel.allowWrites = false;
    panel.expectedPost = null;
    panel.expectedPostBody = null;
    panel.expectedPostFields = undefined;
  }
}
