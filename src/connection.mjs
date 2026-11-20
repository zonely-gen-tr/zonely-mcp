import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync} from 'node:crypto';
export function secret(name){
  if(!name||!/^[A-Z][A-Z0-9_]*$/.test(name))throw Error('A credential environment variable must be configured');
  const value=process.env[name];if(!value)throw Error(`Credential is not set: ${name}`);return value;
}
export function profile(config){
  const p=config.connection;
  if(!p)return null;
  if(!['test','production'].includes(p.environment))throw Error('Connection environment must be test or production');
   
  if(p.environment==='production'&&process.env.ZONELY_ALLOW_PRODUCTION!=='1')throw Error('Production profile requires ZONELY_ALLOW_PRODUCTION=1');
  if(p.api){
    const url=new URL(p.api.url);
    if(url.username||url.password||url.search||url.hash)throw Error('API base URL cannot contain credentials, query or fragment');
    if(url.protocol!=='https:'&&!(p.environment==='test'&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('HTTPS required for remote API');
    if(url.pathname!=='/'&&url.pathname!=='')throw Error('API URL must identify the site origin');
  }
  return p;
}
export function sftpProfileId(connection) {
  const {sftp, api, environment} = connection;
  const roots = Object.entries(sftp.roots ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([
    environment, api ? new URL(api.url).origin : null, sftp.host ?? null,
    sftp.port ?? null, sftp.username ?? null, sftp.hostFingerprint, roots
  ])).digest('hex');
}
function accessFile(config, name) {
  if (name !== 'sftp') throw Error('Unknown private access store');
  return path.join(config.runtime, name + '-access.encrypted.json');
}
export function savePrivateAccess(config, connection, name, binding, access) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret(connection.api.apiKeyEnv), salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(access), 'utf8'), cipher.final()]);
  const record = Object.fromEntries(Object.entries({salt, iv, ciphertext, tag: cipher.getAuthTag()})
    .map(([name, value]) => [name, value.toString('base64')]));
  const file = accessFile(config, name);
  const temporary = file + '.' + iv.toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify({binding, ...record}), {mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
}
export function loadPrivateAccess(config, connection, name, binding) {
  try {
    const record = JSON.parse(fs.readFileSync(accessFile(config, name), 'utf8'));
    if (record.binding !== binding) throw Error('Connection profile changed');
    const key = scryptSync(secret(connection.api.apiKeyEnv), Buffer.from(record.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]));
  } catch {
    throw Error(`Run zonely_sftp_prepare for the configured profile and API key`);
  }
}
export function saveSftpAccess(config, connection, access) {
  return savePrivateAccess(config, connection, 'sftp', sftpProfileId(connection), access);
}
export function loadSftpAccess(config, connection) {
  return loadPrivateAccess(config, connection, 'sftp', sftpProfileId(connection));
}
export function redact(value,secrets=[]){
  const cleanString=s=>secrets.filter(Boolean).reduce((v,key)=>v.split(key).join('[redacted]'),s);
  if(typeof value==='string')return cleanString(value);
  if(Array.isArray(value))return value.map(v=>redact(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/(?:password|passwd|secret|api.?key|access.?token|refresh.?token|bearer.?token|authorization|private.?key|^csrf)/i.test(k)?'[redacted]':redact(v,secrets)]));
  return value;
}
export function importedFile(config,file){
  const root=fs.realpathSync(config.imports),full=fs.realpathSync(path.resolve(root,file));
  const rel=path.relative(root,full);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!fs.statSync(full).isFile())throw Error('File must be inside configured imports directory');
  if(fs.statSync(full).size>30*1024*1024)throw Error('File exceeds 30 MiB transfer limit');
  return full;
}
export function transferFile(config,store,reference){
  if(Number(!!reference.mediaId)+Number(!!(reference.file??reference.importFile))!==1)throw Error('Specify exactly one imported file or managed media ID');
  if(!reference.mediaId)return importedFile(config,reference.file??reference.importFile);
  const media=store.media(reference.mediaId);let relative=media.file;
  if(reference.locale&&reference.locale!==media.source_locale){store.locale(reference.locale);const variant=store.db.prepare('SELECT file FROM media_variants WHERE media_id=? AND locale=?').get(media.id,reference.locale);if(!variant)throw Error('Localized media variant is not ready');relative=variant.file;}
  const root=fs.realpathSync(config.media),full=fs.realpathSync(path.resolve(root,relative)),rel=path.relative(root,full);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||fs.statSync(full).size>30*1024*1024)throw Error('Invalid managed media file');
  return full;
}
