import * as z from 'zod/v4';
import {matchesPost} from './panel-request.mjs';
import {validateText} from './sftp.mjs';

const themesPage = 'panel:site:page:main.selector-theme';
const cards = 'article.theme-card[data-theme-id][data-theme-name]';
const namePattern = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} -]{2,59}$/u;
const themeIdPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const templatePattern = /^(?:Pages|Navigations)\/(?:[a-z0-9_-]+\/){0,5}[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:php|tpl)$/i;
const revisionPattern = /^[a-f0-9]{64}$/i;
const templateDirectives = text => [...text.matchAll(/\[%[\s\S]*?%\]/g)].map(match => match[0]);

async function state(page, name) {
  const themeCards = page.locator(cards);
  await themeCards.first().waitFor({state: 'attached', timeout: 10000});
  const themes = await themeCards.evaluateAll(nodes => nodes.map(theme => ({
    id: theme.dataset.themeId,
    name: theme.dataset.themeName,
    active: theme.classList.contains('theme-card-selected'),
  })));
  const matching = themes.filter(theme => theme.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const active = themes.filter(theme => theme.active);
  if (matching.length > 1 || active.length !== 1) throw Error('The theme list did not identify one active theme and a unique draft.');
  return {draft: matching[0], active: active[0].id};
}

export function createPanelTheme(panel, name, mode) {
  name = name.trim();
  if (!namePattern.test(name)) throw Error('Enter a theme name of 3 to 60 letters, numbers, spaces, or hyphens.');
  return panel.exclusive(async () => {
    const page = await panel.navigate(themesPage);
    const before = await state(page, name);
    if (before.draft || mode === 'preview') return {ready: true, mode, name, draft: before.draft,
      activeTheme: before.active, submitted: false, verified: Boolean(before.draft)};
    await page.locator('#themeCreateOpen').click();
    await page.locator('#themeCreateName').fill(name);
    const endpoint = new URL('/Files/Controllers/ControllersAll.php?main=Workspace&container=WorkspaceThemeCreateController', panel.origin());
    const expected = {name, base_theme: 'Default'};
    const allowed = ['name', 'base_theme', 'csrf_token', 'csrf-token'];
    panel.expectedPost = endpoint;
    panel.expectedPostBody = expected;
    panel.expectedPostFields = allowed;
    panel.oneShotPost = true;
    panel.allowWrites = true;
    const pending = page.waitForResponse(response => matchesPost(response.request(), endpoint, expected, allowed), {timeout: 15000}).catch(() => null);
    let response;
    try {
      await page.locator('#themeCreateSubmit').click();
      response = await pending;
    } finally {
      panel.allowWrites = false;
      panel.expectedPost = null;
      panel.expectedPostBody = null;
      panel.expectedPostFields = null;
      panel.oneShotPost = false;
    }
    const result = await response?.json().catch(() => null);
    const readback = await state(await panel.navigate(themesPage), name);
    if (readback.active !== before.active) throw Error('The active theme changed during the request. Check the theme selector.');
    if (!readback.draft || readback.draft.active) {
      return {name, activeTheme: readback.active, verified: false, submitted: Boolean(response),
        status: response && (!response.ok() || result?.ok === false || result?.success === false || result?.status === 'error') ? 'rejected' : 'unconfirmed'};
    }
    return {name, activeTheme: readback.active, draft: readback.draft, submitted: Boolean(response), verified: true};
  });
}

function workspaceUrl(panel, action, query = {}) {
  const url = new URL('/Files/Controllers/ControllersAll.php', panel.origin());
  url.search = new URLSearchParams({main: 'Workspace', container: `Workspace${action}Controller`, ...query});
  return url.href;
}

async function workspaceGet(panel, page, action, query) {
  const response = await page.request.get(workspaceUrl(panel, action, query), {maxRedirects: 0, timeout: 12000});
  const result = await response.json().catch(() => null);
  if (!response.ok() || result?.status !== 'success') throw Error('The signed-in Templates panel could not read the draft.');
  return result;
}

async function readDraftFile(panel, page, file) {
  const result = await workspaceGet(panel, page, 'FileRead', {root: 'themes', path: file});
  if (result.root !== 'themes' || result.path !== file || result.editable !== true || !revisionPattern.test(result.hash ?? '') ||
      typeof result.content !== 'string' || Buffer.byteLength(result.content) > 512 * 1024) {
    throw Error('The panel did not return the expected editable draft file.');
  }
  return result;
}

function draftWorkspace(panel, theme, file, work) {
  if (!themeIdPattern.test(theme) || !templatePattern.test(file)) throw Error('Select a draft theme ID and a relative template path in Pages or Navigations.');
  return panel.exclusive(async () => {
    const selector = await panel.navigate(themesPage);
    const card = selector.locator(`${cards}[data-theme-id=${JSON.stringify(theme)}]`);
    await card.waitFor({state: 'attached', timeout: 10000});
    const before = await state(selector, await card.getAttribute('data-theme-name'));
    if (before.draft?.id !== theme || before.draft.active || await card.locator('button.theme-owner-edit').count() !== 1) {
      throw Error('Select an inactive theme owned by this site.');
    }
    const page = await panel.navigate('panel:site:page:main.templates');
    const manifest = JSON.parse((await readDraftFile(panel, page, `${theme}/theme.json`)).content);
    if (manifest.id !== theme || manifest.public !== false || manifest.visibility === 'public' || manifest.shared === true) {
      throw Error('Select a private draft theme.');
    }
    const remoteFile = `${theme}/${file}`;
    const current = await readDraftFile(panel, page, remoteFile);
    const presentationFile = file.replace(/\.php$/i, '.tpl');
    validateText(presentationFile, current.content, current.content);
    return work({page, remoteFile, presentationFile, current, active: before.active});
  });
}

export function patchPanelTheme(panel, {theme, file, expectedHash, find, replace}) {
  return draftWorkspace(panel, theme, file, async ({page, remoteFile, presentationFile, current, active}) => {
    if (current.hash !== expectedHash) throw Error('Draft revision conflict. Read the current file and preview the change again.');
    const start = current.content.indexOf(find);
    if (!find || start < 0 || current.content.indexOf(find, start + 1) >= 0) throw Error('The selected text must match exactly once.');
    const content = current.content.slice(0, start) + replace + current.content.slice(start + find.length);
    validateText(presentationFile, content, current.content);
    if (JSON.stringify(templateDirectives(content)) !== JSON.stringify(templateDirectives(current.content))) {
      throw Error('Keep the existing template directives unchanged.');
    }
    if (Buffer.byteLength(content) > 512 * 1024) throw Error('The draft template exceeds the editor size limit.');
    if (content === current.content) return {theme, file, hash: current.hash, verified: true, submitted: false};
    const bootstrap = await workspaceGet(panel, page, 'Bootstrap');
    if (typeof bootstrap.csrf !== 'string' || !bootstrap.csrf || bootstrap.csrf.length > 1000) throw Error('The Templates editor could not verify the session.');
    const response = await page.request.post(workspaceUrl(panel, 'FileSave'), {maxRedirects: 0, timeout: 15000,
      multipart: {csrf_token: bootstrap.csrf, root: 'themes', path: remoteFile, hash: current.hash, content, theme: active}}).catch(() => null);
    const result = await response?.json().catch(() => null);
    const fresh = await readDraftFile(panel, page, remoteFile);
    if (fresh.content !== content) return {theme, file, submitted: Boolean(response), verified: false,
      status: response && (!response.ok() || result?.status !== 'success') ? 'rejected' : 'unconfirmed'};
    return {theme, file, hash: fresh.hash, submitted: Boolean(response), verified: true};
  });
}

export function registerThemePanelTools(tool, panel) {
  tool('zonely_theme_create', 'Create a separate inactive theme based on Default through the signed-in Themes panel. Preview checks the name. Apply verifies the new theme and the active selection after saving. Use apply when requested.',
    {name: z.string().min(3).max(60), mode: z.enum(['preview', 'apply']).default('preview')},
    args => createPanelTheme(panel, args.name, args.mode), false, true);
  const themeFile = {theme: z.string().regex(themeIdPattern), file: z.string().max(240).regex(templatePattern)};
  tool('zonely_theme_draft_read', 'Read up to 16,000 characters and the revision of a private inactive theme template in Pages or Navigations. Returns only editable presentation files.',
    {...themeFile, offset: z.number().int().min(0).max(524288).default(0)}, args => draftWorkspace(panel, args.theme, args.file, ({current}) => ({
      theme: args.theme, file: args.file, hash: current.hash, offset: args.offset, total: current.content.length,
      content: current.content.slice(args.offset, args.offset + 16000),
    })), true, true);
  tool('zonely_theme_draft_patch', 'Apply one exact revision-checked text replacement to a template in a private inactive theme. Read it first. Preserves protected references and verifies the saved file.',
    {...themeFile, expectedHash: z.string().regex(revisionPattern), find: z.string().min(1).max(16000), replace: z.string().max(32000)},
    args => patchPanelTheme(panel, args), false, true);
}
