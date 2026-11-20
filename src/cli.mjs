#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {config, base, settingsDirectory, settingsPath} from './config.mjs';
import {protectCredential, unlockCredential} from './credential.mjs';
import {documentationLanguage, documentationLanguages} from './documentation.mjs';
import {checkUpdate, version} from './version.mjs';

const [action = 'serve', ...args] = process.argv.slice(2);

async function setup() {
  const {values} = parseArgs({args, options: {
    url: {type: 'string'}, lang: {type: 'string'}, api: {type: 'boolean'}, test: {type: 'boolean'},
    'sftp-fingerprint': {type: 'string'}, 'sftp-host': {type: 'string'}, 'sftp-port': {type: 'string'},
  }});
  if (!values.url || !values.lang) {
    if (!process.stdin.isTTY) throw Error('Provide --url and --lang. Use zonely-mcp languages to see language codes.');
    const prompt = createInterface({input: process.stdin, output: process.stdout});
    try {
      values.url ??= await prompt.question('Zonely site URL  ');
      console.log(documentationLanguages().map(({code, name}) => `${code} · ${name}`).join('\n'));
      values.lang ??= await prompt.question('Documentation language [en]  ');
      values.lang ||= 'en';
    } finally { prompt.close(); }
  }
  const address = values.url.trim();
  const origin = new URL(address.includes('://') ? address : 'https://' + address);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(values.test && loopback && origin.protocol === 'http:'))) {
    throw Error('Use the HTTPS site origin without a path, query or credentials.');
  }
  const connection = {
    environment: values.test ? 'test' : 'production',
    docsLanguage: documentationLanguage(values.lang),
    panel: {url: origin.origin},
  };
  const fingerprint = values['sftp-fingerprint'];
  if (fingerprint || values['sftp-host'] || values['sftp-port']) {
    if (!/^(?:[a-f0-9]{64}|SHA256:[A-Za-z0-9+/]{43}=?)$/i.test(fingerprint ?? '')) throw Error('Provide the SFTP server SHA256 fingerprint.');
    const host = values['sftp-host'];
    const port = values['sftp-port'];
    if (host && !/^[a-z0-9.-]+$/i.test(host)) throw Error('Use a hostname for SFTP.');
    if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw Error('Invalid SFTP port.');
    connection.sftp = {useProvisionedAccess: true, hostFingerprint: fingerprint,
      roots: {themes: '/Themes', languages: '/Languages', modules: '/Modules'},
      ...(host ? {host} : {}), ...(port ? {port: Number(port)} : {})};
  }
  const previous = config();
  const sameSite = previous.connection?.panel?.url === origin.origin;
  const key = process.env.ZONELY_SITE_API_KEY?.trim();
  if (values.api || fingerprint || key || (sameSite && previous.connection.api)) {
    connection.api = {url: origin.origin, apiKeyEnv: 'ZONELY_SITE_API_KEY'};
  }
  if (sameSite && previous.connection.sftp && !connection.sftp) connection.sftp = previous.connection.sftp;
  const apiCredential = key ? protectCredential(key) : sameSite ? previous.apiCredential : undefined;
  fs.mkdirSync(settingsDirectory(), {recursive: true, mode: 0o700});
  const file = settingsPath();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({connection, apiCredential}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, {force: true}); }
  console.log(`Site profile saved · ${origin.origin} · ${connection.docsLanguage}`);
  if (connection.api && !apiCredential) console.log('Set ZONELY_SITE_API_KEY in the MCP client environment to enable site API tools.');
}

async function main() {
  switch (action) {
    case 'setup': return setup();
    case 'languages': return console.log(documentationLanguages().map(({code, name}) => `${code}\t${name}`).join('\n'));
    case 'codex-config': {
      const launcher = fileURLToPath(import.meta.url).replaceAll('\\', '/');
      const node = process.execPath.replaceAll('\\', '/');
      const env = ['ZONELY_SITE_API_KEY', 'ZONELY_CONFIG_DIR', 'ZONELY_PYTHON'];
      return console.log(`[mcp_servers.zonely]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(launcher)}, "serve"]\nenv_vars = ${JSON.stringify(env)}\ntool_timeout_sec = 120`);
    }
    case 'mcp-config': {
      const server = {command: process.execPath, args: [fileURLToPath(import.meta.url), 'serve']};
      return console.log(JSON.stringify({mcpServers: {zonely: server}}, null, 2));
    }
    case 'install-browser': {
      const binary = path.join(base, 'node_modules', 'playwright', 'cli.js');
      const {createRequire} = await import('node:module');
      const resolve = createRequire(import.meta.url);
      const playwright = fs.existsSync(binary) ? binary : resolve.resolve('playwright/cli');
      const result = spawnSync(process.execPath, [playwright, 'install', 'chromium'], {stdio: 'ignore'});
      if (result.status !== 0) throw Error('Could not prepare the panel connection.');
      return console.log('Panel connection ready.');
    }
    case 'check-update': return console.log(JSON.stringify(await checkUpdate(), null, 2));
    case '--version': return console.log(version);
    case '--help': case 'help':
      return console.log('zonely-mcp setup [--url https://site.example --lang en]\nzonely-mcp languages\nzonely-mcp install-browser\nzonely-mcp codex-config\nzonely-mcp mcp-config\nzonely-mcp check-update\nzonely-mcp --version');
    case 'serve': {
      const settings = config();
      if (settings.connection?.environment === 'production') process.env.ZONELY_ALLOW_PRODUCTION = '1';
      unlockCredential(settings.apiCredential);
      const {runStdio} = await import('./server.mjs');
      return runStdio(settings);
    }
    default: throw Error(`Unknown command: ${action}. Use zonely-mcp --help.`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
