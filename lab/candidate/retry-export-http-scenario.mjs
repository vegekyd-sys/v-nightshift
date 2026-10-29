// Mechanical recovery checks only. Real paid Agent acceptance is separate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handoffManifestExample } from "../../packages/nightshift-core/src/index.mjs";
import { runHttpScenario as retryWindowScenario } from "./retry-window-http-scenario.mjs";
export async function runHttpScenario({baseUrl,workboard}) {
 const prior=await retryWindowScenario({baseUrl,workboard});
 const api=async(url,body)=>{const r=await fetch(baseUrl+"/api"+url,{headers:{"content-type":"application/json",connection:"close"},...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});const data=await r.json();assert(r.ok,`${url}: ${r.status}`);return data;};
 const flow=(id,stages,extra={})=>JSON.stringify({apiVersion:"nightshift.versa.ai/v1alpha1",kind:"Workflow",metadata:{id,name:id,version:"1.0.0"},spec:{ownerAgentRole:"operator",completion:{mode:"strict-v1"},handoff:{version:1},...extra,stages}});
 const child=await api('/workflows/publish',{sourceYaml:flow('export-recheck-child',[{id:'verify',title:'Synthetic verification',actor:'system',releaseAt:'2099-01-01T00:00:00Z',timeout:'1h',outputs:['result'],completeWhen:['output.result.ready'],outputContracts:{result:{type:'json',equals:{ready:true}}}}],{outputs:{result:{stage:'verify',output:'result'}}})});
 const parent=await api('/workflows/publish',{sourceYaml:flow('export-recheck-parent',[{id:'acquire',title:'Synthetic acquisition',actor:'workflow',timeout:'5m',outputs:['result'],call:{workflow:child.workflowSha256,inputs:{},maxOperations:0},repeat:{until:{output:'result.passed',equals:true},while:{output:'result.again',equals:true},maxIterations:2,maxDuration:'5m',maxOperations:0}},{id:'deliver',title:'Synthetic delivery',actor:'human',timeout:'1h',needs:['acquire']}])});
 const id='NS-EXPORT-RECHECK-1029';
 await api('/instances',{id,name:'Synthetic corrected export acceptance',workflowSha256:parent.workflowSha256,inputs:{},agentBindings:{},status:'active',dispatch:false});
 const tick=()=>api(`/instances/${id}/tick`,{dispatch:false});const root=()=>api(`/instances/${id}`);
 await tick();const call=(await root()).calls[0];const state=await api(`/instances/${call.childId}`);const run=state.stageRuns[0];const dir=state.inputs.nightshift.instanceDir;
 fs.mkdirSync(path.join(dir,'handoffs'),{recursive:true});
 const handoff=handoffManifestExample({instanceId:call.childId,release:child.manifest,stageId:'verify'});handoff.outputs=[{name:'result',sourceStage:'verify',artifact:'verify.json',summary:'synthetic completion fixture'}];
 fs.writeFileSync(path.join(dir,'handoffs/verify.json'),JSON.stringify(handoff));
 const write=facts=>fs.writeFileSync(path.join(dir,'verify.json'),JSON.stringify(facts));
 write({ready:true,passed:false,again:false});await workboard.moveCard(run.cardId,'done');await tick();assert.equal((await root()).calls[0].state,'held');
 write({ready:'false',passed:true,again:false});await api(`/cards/${call.cardId}/retry`,{actor:'V',note:'recheck corrected result'});await tick();let result=await root();
 assert.equal(result.calls[0].state,'held');assert.match(result.calls[0].reason,/output-contract/);assert.equal(result.stageRuns.filter(x=>x.stageId==='deliver').length,0);
 write({ready:true,passed:true,again:false});await api(`/cards/${call.cardId}/retry`,{actor:'V',note:'correct typed output'});await tick();await tick();result=await root();
 assert.equal(result.calls[0].state,'succeeded');assert.equal(result.calls.length,1);assert.equal(result.stageRuns.filter(x=>x.stageId==='deliver').length,1);
 write({ready:false,passed:false,again:false});await api(`/cards/${call.cardId}/retry`,{actor:'V'});await tick();result=await root();assert.equal(result.calls[0].state,'succeeded');assert.equal(result.calls[0].totalOperations,0);
 for(const cardId of [run.cardId,...result.stageRuns.map(x=>x.cardId)]){const {card}=await api(`/cards/${cardId}`);assert(!card.sessionKey&&!card.runId&&!card.metadata?.attempts?.length);}
 await api(`/instances/${id}/pause`,{});await api(`/instances/${id}/archive`,{actor:'V',reason:'mechanical export recheck complete'});
 return {ok:true,checks:{...prior.checks,correctedOriginalExportsRechecked:true,oldValidatedEventCannotBlessChangedInvalidOutput:true,typedFalseCannotReleaseDownstream:true,oneOriginalChildAndNoNewOperation:true,succeededSnapshotNotReopened:true},supplierCalls:0,agentDispatches:0};
}
