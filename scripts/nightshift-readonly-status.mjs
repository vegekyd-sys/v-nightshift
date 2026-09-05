import assert from 'node:assert/strict';import os from 'node:os';
assert.equal(os.hostname(),'VM-8-2-ubuntu');
const health=await fetch('http://127.0.0.1:24879/api/health').then(r=>r.json());
const b=await fetch('http://127.0.0.1:24879/api/bootstrap').then(r=>r.json());
const countBy=(arr,key)=>arr.reduce((a,x)=>(a[x[key]??'unset']=(a[x[key]??'unset']??0)+1,a),{});
console.log(JSON.stringify({health,keys:Object.keys(b),cards:b.cards?.length,cardStatuses:countBy(b.cards??[],'status'),instances:b.instances?.length,instanceStatuses:countBy(b.instances??[],'status'),recentEvents:(b.events??[]).slice(-20).map(e=>({type:e.type,at:e.createdAt})),sampleStageKeys:Object.keys(b.instances?.find(i=>i.stageRuns?.length)?.stageRuns?.[0]??{}),stageStatuses:countBy((b.instances??[]).flatMap(i=>i.stageRuns??[]),'status')}));
