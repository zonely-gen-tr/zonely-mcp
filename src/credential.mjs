import {spawnSync} from 'node:child_process';
import path from 'node:path';

const convert = {
  protect: '$value = [Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $value -AsPlainText -Force)',
  unprotect: '$value = ConvertTo-SecureString ([Console]::In.ReadToEnd()); ([Net.NetworkCredential]::new("", $value)).Password',
};

function dpapi(mode, value) {
  const script = '$ErrorActionPreference = "Stop"; Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); [Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + convert[mode];
  const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) throw Error('Could not access the Windows credential');
  return result.stdout.trim();
}

export function protectCredential(value) {
  if (process.platform !== 'win32' || !value) return undefined;
  return dpapi('protect', value);
}

export function unlockCredential(value) {
  if (value && process.platform === 'win32' && !process.env.ZONELY_SITE_API_KEY) {
    process.env.ZONELY_SITE_API_KEY = dpapi('unprotect', value);
  }
}
