// Real HTTP completion path; synthetic receipts, no Agent/provider execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { operationResultHash, handoffManifestExample } from '../../packages/nightshift-core/src/index.mjs';
export async function terminalAttemptHttpScenario({ baseUrl, workboard, id = 'NS-TERM-1029' }) {
  async function api(url, body) {
    const r = await fetch(`${baseUrl}/api${url}`, { ...(body === undefined ? {} : {method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}}) });
    const data=await r.json(); assert(r.ok,`${url}: ${JSON.stringify(data).slice(0,800)}`); return data;
  }
  const flow=(name,stages,extra={})=>JSON.stringify({apiVersion:'nightshift.versa.ai/v1alpha1',kind:'Workflow',metadata:{id:name,version:'1.0.0',name},spec:{ownerAgentRole:'operator',completion:{mode:'strict-v1'},handoff:{version:1},...extra,stages}});
  // Even if the service's event scheduler runs, native scheduledAt prevents
  // these system fixture cards from launching any Session. Complete only via
  // explicit synthetic test data; the downstream is human, never dispatchable.
  const step=(name,extra={})=>({id:name,title:name,actor:'system',timeout:'1h',releaseAt:'2099-01-01T00:00:00Z',outputs:['receipt'],completeWhen:['output.receipt.exists'],outputContracts:{receipt:{type:'json'}},...extra});
  const child=await api('/workflows/publish',{sourceYaml:flow('terminal-attempt-fixture',[step('attempt',{sideEffects:['external-call'],retry:{maxAttempts:1,idempotencyKey:'a-static-template'},operationCompletion:{mode:'terminal-attempt',output:'receipt'}}),step('verify',{needs:['attempt']})],{outputs:{receipt:{stage:'verify',output:'receipt'}}})});
  const parent=await api('/workflows/publish',{sourceYaml:flow('terminal-repeat-fixture',[{id:'acquire',title:'terminal attempt loop',actor:'workflow',timeout:'1h',outputs:['receipt'],call:{workflow:child.workflowSha256,inputs:{}},repeat:{until:{output:'receipt.accepted',equals:true},while:{output:'receipt.retryable',equals:true},maxIterations:2,maxDuration:'1h',maxOperations:2}}, {id:'deliver',title:'Synthetic downstream',actor:'human',needs:['acquire'],timeout:'1h',outputs:['receipt']}],{limits:{maxOperations:2,maxDuration:'1h'}})});
  await api('/instances',{id,name:'Synthetic terminal-attempt acceptance',workflowSha256:parent.workflowSha256,inputs:{},agentBindings:{},status:'active',dispatch:false});
  const tick=()=>api(`/instances/${id}/tick`,{dispatch:false});
  const root=()=>api(`/instances/${id}`);
  await tick();
  const completed=[];
  async function write(call,stageId,facts) {
    const childInstance=await api(`/instances/${call.childId}`);
    const dir=childInstance.inputs.nightshift.instanceDir;
    assert.equal(path.basename(dir),call.childId);
    const handoff=handoffManifestExample({instanceId:call.childId,release:child.manifest,stageId});
    fs.mkdirSync(path.join(dir,'handoffs'),{recursive:true});
    const artifact=`${stageId}.json`;
    fs.writeFileSync(path.join(dir,artifact),JSON.stringify(facts));
    handoff.outputs=[{name:'receipt',sourceStage:stageId,artifact,summary:'synthetic test only'}];
    fs.writeFileSync(path.join(dir,'handoffs',`${stageId}.json`),JSON.stringify(handoff));
    const card=childInstance.stageRuns.find(r=>r.stageId===stageId).cardId;
    await workboard.moveCard(card,'done'); completed.push(card);
    return card;
  }
  const first=(await root()).calls[0];
  async function attempt(call,status,hash) {
    const c=await api(`/instances/${call.childId}`);const card=c.stageRuns.find(r=>r.stageId==='attempt').cardId;
    const op=await api(`/cards/${card}/operations/reserve`,{requestHash:hash.repeat(64)});
    assert.equal((await api(`/cards/${card}/operations/reserve`,{requestHash:hash.repeat(64)})).reused,true);
    const result={terminal:true,evidence:'synthetic-provider-readback.json',providerStatus:status==='failed'?4:2};
    const checkpoint=await api(`/cards/${card}/operations/checkpoint`,{status,externalTaskId:`synthetic-task-${call.iteration}`,result});
    const facts={attempted:true,succeeded:status==='succeeded',operation:{idempotencyKey:op.idempotencyKey,requestHash:op.requestHash,externalTaskId:checkpoint.externalTaskId,status,resultSha256:operationResultHash(result)}};
    await write(call,'attempt',facts); await tick();
    const after=await api(`/instances/${call.childId}`);
    assert.equal(after.stageRuns.find(r=>r.stageId==='attempt').status,'done');
    assert(after.stageRuns.some(r=>r.stageId==='verify'));
    return {card,op,checkpoint};
  }
  const failed=await attempt(first,'failed','a');
  await write(first,'verify',{accepted:false,retryable:true});await tick();await tick();
  let r=await root();assert.equal(r.calls.length,2);assert(!r.stageRuns.some(run=>run.stageId==='deliver'));
  const second=r.calls[1];const succeeded=await attempt(second,'succeeded','b');assert.notEqual(failed.op.idempotencyKey,succeeded.op.idempotencyKey);
  await write(second,'verify',{accepted:true,retryable:false});await tick();await tick();
  r=await root();assert.equal(r.calls.at(-1).state,'succeeded');assert.equal(r.calls.length,2);assert.equal(r.stageRuns.filter(s=>s.stageId==='deliver').length,1);assert.equal(r.calls[0].operations,1);assert.equal(r.calls[1].totalOperations,2);
  // Reusing the original request does not mutate or re-charge the failed op.
  const reread=await api(`/cards/${failed.card}/operations/reserve`,{requestHash:'a'.repeat(64)});
  assert.equal(reread.status,'failed');assert.deepEqual(reread.result,failed.checkpoint.result);assert.equal(reread.reused,true);
  const cardIds=new Set([...completed,...r.stageRuns.map(s=>s.cardId)]);
  for(const cardId of cardIds){const {card}=await api(`/cards/${cardId}`);assert(!card.sessionKey && !card.runId && !card.metadata?.attempts?.length);}
  await api(`/instances/${id}/pause`,{});await api(`/instances/${id}/archive`,{actor:'V',reason:'synthetic acceptance complete; no provider calls'});
  return {ok:true,checks:{realHttpFailedOperationCompletesAttempt:true,failedLedgerPreserved:true,independentVerificationRoutesNextRound:true,successReleasesDownstreamOnce:true,failedOperationsCountAgainstLimit:true,repeatReserveReusesOldFailure:true,noAgentOrProviderCalls:true},projectId:id,controllerCardId:first.cardId};
}
