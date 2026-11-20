import {spawn} from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
export class Worker {
  constructor(config) { this.config=config; this.pending=new Map(); this.next=0; }
  request(data) {
    if (!this.child) {
      const log=fs.openSync(this.config.workerLog,'a');
      this.child=spawn(this.config.python,[this.config.worker],{stdio:['pipe','pipe',log],windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});
      fs.closeSync(log);
      readline.createInterface({input:this.child.stdout}).on('line',line=>{
        let msg; try { msg=JSON.parse(line); } catch { return; }
        const pending=this.pending.get(msg.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(msg.id);
        msg.error ? pending.reject(Error(msg.error)) : pending.resolve(msg.result);
      });
      const fail=error=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.child=null;};
      this.child.on('error',fail);this.child.on('exit',code=>fail(Error(`Model worker exited (${code})`)));
    }
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Model worker timed out'));this.child?.kill();},180000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({...data,id})+'\n');
    });
  }
  close(){this.child?.kill();}
}
