import {DatabaseSync} from 'node:sqlite';import os from 'node:os';import assert from 'node:assert/strict';
assert.equal(os.hostname(),'VM-8-2-ubuntu');
const db=new DatabaseSync('/home/openclaw/.openclaw/nightshift/nightshift.sqlite',{readOnly:true});
console.log(JSON.stringify({events:db.prepare('SELECT type,count(*) n,max(created_at) latest FROM audit_events WHERE created_at >= ? GROUP BY type ORDER BY latest DESC').all('2026-09-05T00:00:00Z')}));db.close();
const b=await fetch('http://127.0.0.1:24879/api/bootstrap').then(r=>r.json());
console.log(JSON.stringify({stageRuns:(b.instances??[]).flatMap(i=>(i.stageRuns??[]).map(r=>({instanceStatus:i.status,status:r.status,updatedAt:r.updatedAt}))).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,8)}));
