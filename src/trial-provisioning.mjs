import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {domainToASCII} from 'node:url';
import {chromium} from 'playwright';
import * as z from 'zod/v4';

const accountOrigin = 'https://accounts.zonely.gen.tr';
const productsPath = '/tr/products';
const loginPath = '/tr/login';
const trialPath = '/tr/buy/zonely';
const drawerPath = '/Files/Controllers/Drawers/store/product.view.unified.php?id=3&view=product&payment=credit';
const checkoutPath = '/Files/Controllers/ControllersAll.php?main=Buys&container=UnifiedBuy';
const productId = '3';
const previewLifetime = 5 * 60 * 1000;

export function trialDomain(value) {
  const trimmed = value.trim().toLowerCase();
  const domain = /^[\p{L}\p{M}\p{N}.-]+$/u.test(trimmed) ? domainToASCII(trimmed) : '';
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      ['localhost', 'local', 'invalid', 'onion', 'example'].includes(labels.at(-1))) {
    throw Error('Enter the domain or subdomain you control, without a URL, port, or path.');
  }
  return domain;
}

function inspectProducts({html, domain}) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const matches = [...document.querySelectorAll('.license-card .btn-dns-guide[data-domain]')]
    .filter(button => button.getAttribute('data-domain').toLowerCase() === domain);
  return matches.map(button => {
    const hero = button.closest('.license-card').querySelector('.license-hero[data-license-id][data-product-id]');
    return {id: hero?.getAttribute('data-license-id'), product: hero?.getAttribute('data-product-id')};
  });
}

function inspectTrial(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const modal = document.querySelector('.zonely-shop-modal');
  return {id: modal?.getAttribute('data-product-id'), title: modal?.getAttribute('data-direct-title'),
    total: modal?.getAttribute('data-current-total'), base: modal?.getAttribute('data-base-amount'),
    stock: modal?.getAttribute('data-out-of-stock'), endpoint: modal?.getAttribute('data-buy-url'),
    csrf: document.querySelector('input[name="csrf-token"]')?.value};
}

const zero = value => typeof value === 'number' ? value === 0 : typeof value === 'string' && /^0+(?:[.,]0+)?$/.test(value);

export class TrialProvisioning {
  constructor(directory, launch = (profile, options) => chromium.launchPersistentContext(profile, options)) {
    this.directory = directory;
    this.launch = launch;
    this.queue = Promise.resolve();
    this.previews = new Map();
  }

  run(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async openContext(headless) {
    mkdirSync(this.directory, {recursive: true, mode: 0o700});
    try {
      return await this.launch(path.join(this.directory, 'session'), {headless, args: ['--mute-audio'], timeout: 12000});
    } catch {
      throw Error('Could not start the account session. Check the package installation and close any other client using this account profile.');
    }
  }

  openLogin() {
    return this.run(async () => {
      const tab = this.loginContext?.pages().find(page => !page.isClosed());
      if (tab) return {...this.signInRequired(), status: 'sign_in_open'};
      await this.loginContext?.close().catch(() => {});
      this.previews.clear();
      this.accountCookies = undefined;
      const context = await this.openContext(false);
      this.loginContext = context;
      try {
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(accountOrigin + loginPath, {waitUntil: 'domcontentloaded', timeout: 12000});
        if (new URL(page.url()).origin !== accountOrigin) throw Error('Unexpected account address');
        return {...this.signInRequired(), status: 'sign_in_open'};
      } catch {
        await context.close().catch(() => {});
        this.loginContext = undefined;
        throw Error('Could not open the official account sign-in page.');
      }
    });
  }

  signInRequired() {
    return {status: 'sign_in_required', loginUrl: accountOrigin + loginPath, registrationUrl: accountOrigin + '/tr/register'};
  }

  async session(operation) {
    let interactive = Boolean(this.loginContext?.pages().length);
    let context = interactive ? this.loginContext : await this.openContext(true);
    try {
      if (!interactive && this.accountCookies?.length) await context.addCookies(this.accountCookies);
      let products = await this.products(context);
      if (products === null) return this.signInRequired();
      if (interactive) {
        this.accountCookies = await context.cookies(accountOrigin);
        await context.close();
        this.loginContext = undefined;
        interactive = false;
        context = await this.openContext(true);
        await context.addCookies(this.accountCookies);
        products = await this.products(context);
        if (products === null) return this.signInRequired();
      }
      const page = context.pages()[0] ?? await context.newPage();
      return await operation(context, page, products);
    } finally {
      if (!interactive) {
        this.accountCookies = await context.cookies(accountOrigin).catch(() => undefined);
        await context.close().catch(() => {});
      }
    }
  }

  async request(context, route, options = {}) {
    try {
      return await context.request.fetch(accountOrigin + route, {timeout: 14000, maxRedirects: 0, ...options});
    } catch {
      throw Error('The account service did not respond. Check the current account status before repeating a submission.');
    }
  }

  async products(context) {
    const response = await this.request(context, productsPath);
    if ([301, 302, 303, 307, 308, 401].includes(response.status())) {
      const location = new URL(response.headers().location ?? loginPath, accountOrigin);
      if (location.origin === accountOrigin && (location.pathname === '/404' || /\/(?:login|2fa)\/?$/i.test(location.pathname))) return null;
    }
    if (!response.ok()) throw Error('Could not verify the signed-in account’s products.');
    return response.text();
  }

  async license(context, page, domain, products) {
    const html = products ?? await this.products(context);
    if (html === null) throw Error('The account session has expired. Sign in and check its products again.');
    const matches = await page.evaluate(inspectProducts, {html, domain});
    if (!matches.length) return null;
    if (matches.length !== 1 || !/^[1-9]\d{0,14}$/.test(matches[0].id ?? '')) throw Error('The account has an ambiguous license record for this domain. Check its products.');
    const [license] = matches;
    return {status: 'dns_step', domain, licenseId: license.id, trial: license.product === productId,
      productsUrl: accountOrigin + productsPath, nextAction: 'open_dns_guide_for_domain', dnsChanged: false};
  }

  async sessionBinding(context) {
    const cookies = await context.cookies(accountOrigin);
    const value = cookies.filter(cookie => cookie.httpOnly).map(({name, value}) => `${name}=${value}`).sort().join('\n');
    if (!value) throw Error('Sign in to the official account before preparing a trial.');
    return createHash('sha256').update(value).digest('hex');
  }

  async checkoutDetails(context, page) {
    const response = await this.request(context, drawerPath, {headers: {'X-Requested-With': 'XMLHttpRequest'}});
    if (!response.ok()) throw Error('The official trial offer is unavailable.');
    const offer = await page.evaluate(inspectTrial, await response.text());
    if (offer.id !== productId || !/\b(?:deneme|trial)\b/i.test(offer.title ?? '') ||
        !zero(offer.total) || !zero(offer.base) || offer.stock !== '0' || offer.endpoint !== checkoutPath) {
      throw Error('The account’s offer could not be verified as an available zero-cost trial.');
    }
    return offer;
  }

  async checkout(context, domain, offer, action) {
    const response = await this.request(context, checkoutPath, {method: 'POST',
      form: {view: 'product', payment: 'credit', productid: productId, quantity: '1', domainadress: domain, action,
        ...(offer.csrf ? {'csrf-token': offer.csrf} : {})},
      headers: {Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: accountOrigin, Referer: accountOrigin + '/tr/profile'}});
    if (!response.ok()) throw Error('The account service could not process the request.');
    return response.json().catch(() => { throw Error('The account service returned an unexpected response.'); });
  }

  pendingPath(domain) {
    return path.join(this.directory, `pending-${createHash('sha256').update(domain).digest('hex')}`);
  }

  async prepare(context, page, domain) {
    const offer = await this.checkoutDetails(context, page);
    const result = await this.checkout(context, domain, offer, 'checkDomain');
    if (result.status === 'domain_verification_required') return {status: 'ownership_verification_required', domain,
      trialUrl: accountOrigin + trialPath, nextAction: 'complete_domain_ownership_check_in_account', dnsChanged: false};
    if (result.status !== 'dns_clear' || (result.domain !== undefined && result.domain !== domain)) {
      return {status: 'domain_unavailable', domain, productsUrl: accountOrigin + productsPath};
    }
    return {offer};
  }

  check(value, preview = false) {
    const domain = trialDomain(value);
    return this.run(() => this.session(async (context, page, products) => {
      const existing = await this.license(context, page, domain, products);
      if (existing) return {...existing, alreadyExists: true};
      if (existsSync(this.pendingPath(domain))) return {status: 'submission_unconfirmed', domain, productsUrl: accountOrigin + productsPath};
      if (!preview) return {status: 'no_license_found', domain};
      const ready = await this.prepare(context, page, domain);
      if (!ready.offer) return ready;
      const time = Date.now();
      for (const [token, entry] of this.previews) if (time >= entry.until) this.previews.delete(token);
      if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value);
      const token = randomUUID();
      this.previews.set(token, {domain, binding: await this.sessionBinding(context), until: time + previewLifetime});
      return {status: 'ready_for_confirmation', domain, total: 0, token, expiresInSeconds: previewLifetime / 1000,
        nextAction: 'obtain_user_approval_for_this_trial', dnsChanged: false};
    }));
  }

  apply(value, token) {
    const domain = trialDomain(value);
    return this.run(() => this.session(async (context, page, products) => {
      const existing = await this.license(context, page, domain, products);
      if (existing) return {...existing, alreadyExists: true};
      const attempt = this.pendingPath(domain);
      if (existsSync(attempt)) return {status: 'submission_unconfirmed', domain, productsUrl: accountOrigin + productsPath};
      const preview = this.previews.get(token);
      if (preview?.domain !== domain || Date.now() >= preview.until || preview.binding !== await this.sessionBinding(context)) {
        throw Error('Prepare a fresh preview for this domain in the same account and confirm it before applying.');
      }
      this.previews.delete(token);
      const ready = await this.prepare(context, page, domain);
      if (!ready.offer) return ready;
      if (preview.binding !== await this.sessionBinding(context)) throw Error('The account session changed. Prepare a fresh preview.');
      try {
        writeFileSync(attempt, '', {flag: 'wx', mode: 0o600});
      } catch (error) {
        if (error.code !== 'EEXIST') throw Error('Could not record the trial request locally.');
        return {status: 'submission_unconfirmed', domain, productsUrl: accountOrigin + productsPath};
      }
      const result = await this.checkout(context, domain, ready.offer, 'purchase').catch(() => null);
      if (result?.status === 'domain_verification_required') {
        unlinkSync(attempt);
        return {status: 'ownership_verification_required', domain, trialUrl: accountOrigin + trialPath,
          nextAction: 'complete_domain_ownership_check_in_account', dnsChanged: false};
      }
      const verified = await this.license(context, page, domain).catch(() => null);
      if (verified && result?.status === 'success' && zero(result.data?.total) && verified.trial) {
        unlinkSync(attempt);
        return {...verified, verified: true, total: 0};
      }
      return {status: 'submission_unconfirmed', domain, productsUrl: accountOrigin + productsPath,
        nextAction: 'check_account_products_before_retrying', dnsChanged: false};
    }));
  }
}

export function registerTrialProvisioning(tool, directory) {
  const trial = new TrialProvisioning(directory);
  const domain = z.string().min(3).max(253);
  tool('zonely_account_sign_in', 'Open the official account sign-in page for a new site only after the customer requests or agrees to opening it. Sign-in and account registration are completed by the customer.',
    {open: z.literal(true)}, () => trial.openLogin(), false, true);
  tool('zonely_trial_preview', 'Check the domain against the signed-in account and verify the current total for a zero-cost trial. Shows the account sign-in step if needed. Ask the customer to approve the exact domain and total before applying.',
    {domain}, args => trial.check(args.domain, true), true, true);
  tool('zonely_trial_apply', 'Claim one approved zero-cost trial and verify the license in the customer’s account. Use the token from the preview for the same domain after explicit approval. Returns the DNS guide step and never modifies DNS or starts hosting.',
    {domain, token: z.uuid(), confirmed: z.literal(true)}, args => trial.apply(args.domain, args.token), false, true);
  tool('zonely_trial_status', 'Check whether the signed-in account has a license and DNS guide for this exact domain. Use this after an uncertain submission without retrying it.',
    {domain}, args => trial.check(args.domain), true, true);
}
