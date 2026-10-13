// Source-only candidate: real private Gateway + native Workboard, no Agent dispatch,
// no credentials printed, no media production, and no customer/Base writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NightShiftStore } from '../../packages/nightshift-core/src/store.mjs';
import { NightShiftRuntime } from '../../packages/nightshift-core/src/runtime.mjs';
import { WorkboardGatewayAdapter } from '../../packages/nightshift-core/src/workboard-gateway-adapter.mjs';
import { validateProjectRequest } from '../../packages/nightshift-core/src/project.mjs';
import { DeliveryIntakeService } from '../../apps/nightshift-dashboard/server/delivery-intake.mjs';
import { canonicalJson } from '../../apps/nightshift-dashboard/delivery/review.js';
const runtimeDir=process.env.VLAB_CANDIDATE_RUNTIME, configPath=process.env.OPENCLAW_CONFIG_PATH, stateDir=process.env.OPENCLAW_STATE_DIR;
assert(runtimeDir&&configPath&&stateDir,'private candidate environment required');
const config=JSON.parse(await fs.readFile(configPath,'utf8'));const port=config.gateway.port;
config.channels={};config.bindings=[];config.cron={enabled:false};config.plugins={allow:[],entries:{}};
config.agents={defaults:{workspace:path.join(stateDir,'workspace'),heartbeat:{every:'0m'}},entries:{makaron:{workspace:path.join(stateDir,'workspace')}}};
await fs.mkdir(config.agents.defaults.workspace,{recursive:true});await fs.writeFile(configPath,JSON.stringify(config),{mode:0o600});
const entry=path.join(runtimeDir,'openclaw/dist/index.js');
const child=spawn(process.execPath,['--max-old-space-size=1024',entry,'gateway','--port',String(port)],{env:process.env,stdio:['ignore','pipe','pipe']});
// Never return raw Gateway log/config because they may contain credential metadata.
const diagnostic=[];
const safeWords=new Set('gateway mode local blocked error failed refused required port token auth config plugin worker permission path lock timeout leader active running another instance already occupied busy bind listen managed allow unsafe bootstrap missing connect expired enabled disable openclaw service startup initialization validation invalid startup release ownership shell command agent model primary default denied acquire start stopped sandbox rpc process signals heartbeat entry native policy operator repair startup source retry operation config-path state-dir supports requires not cannot is are with without for on at to the and invalid request role trusted origin ready ws disconnected channels cron'.split(' '));
for(const stream of [child.stdout,child.stderr]){stream.setEncoding('utf8');stream.on('data',chunk=>{for(const line of chunk.split(/\r?\n/u)){if(line.trim())diagnostic.push((line.match(/Unsafe[^:\n]+/u)?.[0] ?? '') + ' ' + line.replace(/[A-Za-z0-9_./:+@=-]+/gu,word=>safeWords.has(word.toLowerCase())?word:'_').slice(0,200));}if(diagnostic.length>50)diagnostic.splice(0,diagnostic.length-50);});}
const board='f-intake-candidate';const workboard=new WorkboardGatewayAdapter({board,configPath,entry,gatewayUrl:`ws://127.0.0.1:${port}`});
const scratch=path.join(process.env.VLAB_CANDIDATE_DATA??stateDir,'f-intake');await fs.mkdir(scratch,{recursive:true});
let store=new NightShiftStore(path.join(scratch,'nightshift.sqlite'));
let runtime=new NightShiftRuntime({store,workboard,board});
try{
 let connected=false;
 for(let attempt=0;attempt<90;attempt++){
  if(child.exitCode!==null)throw new Error(`private Gateway exited ${child.exitCode}; ${diagnostic.slice(-8).join("; ")}`);
  try{await workboard.connect();connected=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}
 }
 assert(connected,'private Gateway connection');
 const published=runtime.publish(await fs.readFile('examples/workflows/xingqing-buffer-intake-f.workflow.md','utf8'));
 const sourceId='F-NATIVE-CANDIDATE'; const manifestUrl=`https://cdn.makaron.app/qa/${sourceId}/manifest.json`;
 const manifest={version:1,title:'Synthetic candidate',batchId:sourceId,review:{enabled:true,sourceProjectId:sourceId},items:Array.from({length:7},(_,i)=>({id:`v${i+1}`,title:`Synthetic ${i+1}`,url:`https://cdn.makaron.app/qa/${i+1}.mp4`}))};
 const source={id:sourceId,status:'done',workflowSha256:'synthetic',agentBindings:{'content-operator':'makaron'},inputs:{enterpriseName:'Synthetic',planningDocUrl:'https://example.feishu.cn/docx/synthetic',targetCount:7,testScope:{productionCount:7,publishCount:5,reserveCount:2,workdays:5,accountRecordId:'synthetic',serviceRecordId:'synthetic-service'},publicationTarget:{accountRecordId:'synthetic',geelarkDeviceId:'123456789012345678',tiktokHandle:'synthetic',market:'巴西',language:'葡萄牙语',timezone:'America/Sao_Paulo'}}};
 const deps={loadSource:async()=>({source,sourceRelease:{metadata:{id:'xingqing-night-f'}},manifest,contentItems:manifest.items,page:{published:true,manifest:manifestUrl},instanceDir:path.join(scratch,sourceId)}),store,createTask:async request=>{validateProjectRequest(published.manifest,request);return runtime.startInstance(request);},enqueue:()=>{},projectLinks:id=>({project:`/?project=${id}`})};
 const body={manifestUrl,manifestHash:createHash('sha256').update(canonicalJson(manifest)).digest('hex'),rejectedIds:[]};
 const confirmed=await new DeliveryIntakeService(deps).submit(sourceId,body,'synthetic-operator');
 const first=await runtime.tick(confirmed.task.id,{dispatch:false,inspectSessions:false});
 assert.equal(first.applied.filter(r=>r.status==='created').length,1);
 const cards=await workboard.listCards({cardIds:runtime.instanceCardIds(confirmed.task.id)});
 assert.equal(cards.length,1);assert.equal(cards[0].status,'ready');assert.equal(cards[0].agentId,'makaron');
 assert.ok(cards[0].labels.includes('stage:buffer-intake'));assert.ok(cards[0].labels.some(label=>label.includes('bf:123456789012345678')));
 store.close();store=new NightShiftStore(path.join(scratch,'nightshift.sqlite'));runtime=new NightShiftRuntime({store,workboard,board});
 const again=await new DeliveryIntakeService({...deps,store}).submit(sourceId,body,'synthetic-operator');assert.equal(again.task.id,confirmed.task.id);
 const second=await runtime.tick(confirmed.task.id,{dispatch:false,inspectSessions:false});assert.equal(second.applied.filter(r=>r.status==='created').length,0);
 const after=await workboard.listCards({cardIds:runtime.instanceCardIds(confirmed.task.id)});assert.equal(after.length,1);assert.equal(after[0].id,cards[0].id);
 console.log(JSON.stringify({ok:true,nativeCardCreated:true,nativeCardReady:true,assignedAgent:'makaron',confirmationRestoredFromSqlite:true,sameCardAfterRestart:true,agentDispatched:false,customerWrites:false,publication:false}));
}finally{
 await workboard.close().catch(()=>{});store.close();child.kill('SIGTERM');
 await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,10000))]);if(child.exitCode===null)child.kill('SIGKILL');
}
