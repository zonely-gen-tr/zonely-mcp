import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const uid=()=>randomUUID();
export const now=()=>new Date().toISOString();
export class Store {
  constructor(root,locales){
    fs.mkdirSync(root,{recursive:true});
    this.db=new DatabaseSync(path.join(root,'sandbox.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS site (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locales (code TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY,kind TEXT NOT NULL,key TEXT NOT NULL UNIQUE,source_locale TEXT NOT NULL REFERENCES locales(code),title TEXT NOT NULL,body TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin='mcp'),revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',media_id TEXT REFERENCES media(id));
      CREATE TABLE IF NOT EXISTS translations (content_id TEXT NOT NULL REFERENCES content(id),locale TEXT NOT NULL REFERENCES locales(code),source_revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,method TEXT NOT NULL,review TEXT NOT NULL,PRIMARY KEY(content_id,locale));
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY,sha TEXT UNIQUE NOT NULL,source_locale TEXT NOT NULL REFERENCES locales(code),file TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_variants (media_id TEXT NOT NULL REFERENCES media(id),locale TEXT NOT NULL REFERENCES locales(code),file TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(media_id,locale));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,payload TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,owner_pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory (cache_key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (revision INTEGER PRIMARY KEY,config TEXT NOT NULL,created_at TEXT NOT NULL);`);
    const insert=this.db.prepare('INSERT OR IGNORE INTO locales VALUES (?,?)');
    for(const l of locales)insert.run(l.app,l.name);
    this.db.prepare('INSERT OR IGNORE INTO site VALUES (1,1,?)').run(JSON.stringify({name:'Zonely Test Topluluğu',theme:'Norix',primary:'#4f8c65',background:'#101a15',radius:20,sectionOrder:[]}));
     
    for(const j of this.db.prepare("SELECT id,owner_pid FROM jobs WHERE state IN ('queued','running')").all()){
      let alive=true;try{process.kill(j.owner_pid,0);}catch{alive=false;}
      if(!alive)this.db.prepare("UPDATE jobs SET state='failed',error='Process stopped before completion; retry the job',updated_at=? WHERE id=?").run(now(),j.id);
    }
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(action,target,detail={}){this.db.prepare('INSERT INTO audit(action,target,detail,created_at) VALUES (?,?,?,?)').run(action,target,JSON.stringify(detail),now());}
  locale(code){if(!this.db.prepare('SELECT code FROM locales WHERE code=?').get(code))throw Error('Locale is not enabled: '+code);return code;}
  site(){const r=this.db.prepare('SELECT * FROM site WHERE id=1').get();return {...JSON.parse(r.config),revision:r.revision};}
  content(id){const r=this.db.prepare('SELECT * FROM content WHERE id=? OR key=?').get(id,id);if(!r)throw Error('Content not found');return r;}
  media(id){const r=this.db.prepare('SELECT * FROM media WHERE id=?').get(id);if(!r)throw Error('Media not found');return {...r,metadata:JSON.parse(r.metadata)};}
  job(id){const r=this.db.prepare('SELECT id,kind,state,progress,total,result,error,created_at,updated_at FROM jobs WHERE id=?').get(id);if(!r)throw Error('Job not found');return {...r,result:r.result?JSON.parse(r.result):null};}
  close(){this.db.close();}
}
