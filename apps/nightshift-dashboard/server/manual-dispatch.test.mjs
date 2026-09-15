import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("./index.mjs",import.meta.url),"utf8");
const body=source.slice(source.indexOf("async function serializedTick("),source.indexOf("function positiveInteger("));
test("manual tick and retry launch requests enter the guarded scheduler", async()=>{
 const ticks=[],queued=[];
 const tick=vm.runInNewContext(body+';serializedTick',{serializedOperation:f=>f(),tickWithFaultProjection:async x=>{ticks.push(x.options);return {actions:[],applied:[]};},runtime:{},store:{},workboard:{},changeScheduler:{enqueue:t=>queued.push(t)}});
 await Promise.all([tick('a',{dispatch:true}),tick('b',{dispatch:true}),tick('c',{dispatch:true,dryRun:true})]);
 assert(ticks.every(x=>x.dispatch===false));assert.equal(queued.length,2);
});
