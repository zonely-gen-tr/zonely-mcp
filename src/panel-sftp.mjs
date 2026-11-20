import fs from 'node:fs';
import path from 'node:path';
import {Client as SshClient} from 'ssh2';
import SftpClient from 'ssh2-sftp-client';

export async function preparePanelSftp(panel, runtime, expectedTheme = '') {
  const origin=panel.origin();
  const data=await panel.exclusive(async()=>{
    const page=await panel.navigate('panel:site:page:main.templates');
    const target=new URL('/Files/Controllers/ControllersAll.php?main=Templates&container=TemplatesSftpAccessController',origin);
    const match=request=>request.method()==='POST'&&request.url()===target.href;
    panel.addonWrite=request=>{
      if(!match(request))return false;
      panel.addonWrite=null;
      return true;
    };
    try{
      const [response]=await Promise.all([
        page.waitForResponse(item=>match(item.request()),{timeout:45000}),
        page.locator('#workspaceSftpAccess').click(),
      ]);
      const value=await response.json();
      if(!response.ok()||value?.status!=='success'||value.sync?.errors?.length)
        throw Error('SFTP preparation was rejected');
      return value;
    }catch{
      throw Error('Could not prepare SFTP access through Templates');
    }finally{
      panel.addonWrite=null;
    }
  });
  const {host,port:rawPort,username,password,theme}=data.access??{};
  const port=Number(rawPort??22);
  if(typeof host!=='string'||!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host)||
     !Number.isInteger(port)||port<1||port>65535||
     typeof username!=='string'||!username||typeof password!=='string'||!password||
     typeof theme!=='string'||!/^[a-z0-9_-]{1,80}$/i.test(theme)||
     (expectedTheme&&theme!==expectedTheme))throw Error('Templates did not supply the expected active theme access');

  const identityPath=path.join(runtime,'panel-sftp-first-host.json');
  const identity={site:origin,host,port};
  const known=fs.existsSync(identityPath)?JSON.parse(fs.readFileSync(identityPath,'utf8')):null;
  if(known&&(known.site!==origin||known.host!==host||known.port!==port))
    throw Error('The SFTP server changed since the last panel connection');
  let hostFingerprint=known?.fingerprint;
  if(!hostFingerprint){
    hostFingerprint=await observeHostKey(host,port);
    fs.writeFileSync(identityPath,JSON.stringify({...identity,fingerprint:hostFingerprint}),{flag:'wx',mode:0o600});
  }
  if(!/^[a-f0-9]{64}$/.test(hostFingerprint))throw Error('The saved SFTP server key is invalid');

  const sftp=new SftpClient('zonely-panel');
  try{
    await sftp.connect({host,port,username,password,hostHash:'sha256',
      hostVerifier:value=>value===hostFingerprint,readyTimeout:15000,retries:0});
    for(const directory of ['/Themes','/Views/Themes']){
      const root=path.posix.join(directory,theme);
      if(await sftp.exists(root)==='d'){
        return {profile:{host,port,username,hostFingerprint,roots:{themes:root}},password,theme,
          imported:Number(data.sync?.imported??0),exported:Number(data.sync?.exported??0)};
      }
    }
    throw Error('Active theme folder not found');
  }catch{
    throw Error('The SFTP server key or active theme could not be verified');
  }finally{
    await sftp.end().catch(()=>{});
  }
}

function observeHostKey(host,port){
  const client=new SshClient();
  return new Promise((resolve,reject)=>{
    let observed;
    const fail=()=>/^[a-f0-9]{64}$/.test(observed??'')?resolve(observed):reject(Error('Could not retrieve the SFTP server key'));
    client.once('error',fail);
    client.once('close',fail);
    client.connect({host,port,username:'zonely-host-key',readyTimeout:15000,hostHash:'sha256',
      hostVerifier:value=>{
        observed=value;
        return false;
      }});
  });
}
