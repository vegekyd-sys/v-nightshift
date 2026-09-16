import assert from "node:assert/strict";
import test from "node:test";
import {createHostPressureProbe} from "./host-pressure-probe.mjs";
import {DispatchPressureGuard} from "./dispatch-pressure-guard.mjs";
function fixture(){let at=0,pages=1000,available=8*1024*1024,memory=0,io=0,fail=false;
 const probe=createHostPressureProbe({gatewayUrl:"ws://127.0.0.1:24993",platform:"linux",now:()=>at,read:async p=>{if(fail)throw Error("unavailable");return p==="/proc/meminfo"?`MemTotal: 16777216 kB\nMemAvailable: ${available} kB`:p==="/proc/vmstat"?`pswpout ${pages}`:`some avg10=0.00 avg60=0.00\nfull avg10=${p.endsWith("memory")?memory:io} avg60=0.00`;}});
 return {probe,step:(ms=5000)=>at+=ms,set:v=>{({pages=pages,available=available,memory=memory,io=io,fail=fail}=v);}};
}
test("healthy local samples permit dispatch only after swap rate is known",async()=>{const f=fixture();assert((await f.probe()).blocked);f.step();const p=await f.probe();assert(!p.blocked);assert.equal(p.swapOutPagesPerSecond,0);assert.equal(p.availableMiB,8192);});
test("memory and swap pressure each independently block new work",async()=>{for(const values of [{available:2*1024*1024},{memory:1},{pages:6120}]){const f=fixture();await f.probe();f.step();f.set(values);assert((await f.probe()).blocked,JSON.stringify(values));}});
test("missing metrics, stale samples and counter reset require fresh observations",async()=>{const f=fixture();await f.probe();f.step(15001);assert((await f.probe()).blocked);f.step();f.set({pages:1});assert((await f.probe()).blocked);f.step();assert(!(await f.probe()).blocked);f.set({fail:true});assert((await f.probe()).blocked);f.set({fail:false});f.step();assert((await f.probe()).blocked);});
test("does not mistake a remote Gateway for the dashboard host",async()=>{for(const [platform,gatewayUrl] of [["darwin","ws://127.0.0.1:24993"],["linux","ws://vlab.example:24993"]]){const p=await createHostPressureProbe({platform,gatewayUrl,read:()=>{throw Error("must not read");}})();assert.equal(p.enabled,false);assert.equal(p.blocked,false);}});
test("host pressure blocks a fast unqueued Gateway and requires sustained recovery",()=>{let now=0;const g=new DispatchPressureGuard({now:()=>now,initialMaxActive:12});const probe={running:12,workerPool:{capacity:45,active:12,queued:0},latencyMs:2};assert.equal(g.recordProbe({...probe,hostPressure:{enabled:true,blocked:true,reason:"active swap-out"}}).availableStarts,0);for(now=5000;now<20000;now+=5000)assert.equal(g.recordProbe({...probe,hostPressure:{enabled:true,blocked:false}}).availableStarts,0);assert.equal(g.recordProbe({...probe,hostPressure:{enabled:true,blocked:false}}).availableStarts,1);g.consumeStarts(1);assert.equal(g.snapshot(13).availableStarts,0);});

test("background disk activity alone does not starve an otherwise healthy host",async()=>{const f=fixture();await f.probe();f.step();f.set({io:60});const p=await f.probe();assert.equal(p.ioFullAvg10,60);assert.equal(p.blocked,false);});

// The live elastic batch exhausted memory between otherwise green probes.
test("reserves allocation headroom before reclaim or swap begins and recovers when released",async()=>{const f=fixture();await f.probe();f.step();f.set({available:5*1024*1024});const held=await f.probe();assert.equal(held.memoryFullAvg10,0);assert.equal(held.swapOutPagesPerSecond,0);assert.equal(held.blocked,true);assert.equal(held.reason,"insufficient memory headroom");assert.equal(held.admissionReserveMiB,6554);f.step();f.set({available:8*1024*1024});assert.equal((await f.probe()).blocked,false);});

// Production has twice the lab's RAM; the reserve must follow the host, not a constant.
test("operators size the admission reserve per host",async()=>{let at=0;const make=(o)=>createHostPressureProbe({gatewayUrl:"ws://127.0.0.1:22793",platform:"linux",now:()=>at,read:async p=>p==="/proc/meminfo"?"MemTotal: 33554432 kB\nMemAvailable: 8388608 kB":p==="/proc/vmstat"?"pswpout 0":"some avg10=0.00\nfull avg10=0.00 avg60=0.00",...o});
 const lenient=make({reserveFloorMiB:4096,reservePercent:20});await lenient();at+=5000;const l=await lenient();assert.equal(l.admissionReserveMiB,6554);assert.equal(l.blocked,false);
 const strict=make({});await strict();at+=5000;const s=await strict();assert.equal(s.admissionReserveMiB,13108);assert.equal(s.reason,"insufficient memory headroom");
 for(const bad of [{reservePercent:0},{reservePercent:100},{reserveFloorMiB:-1}])assert.throws(()=>make(bad),/must be/);});
