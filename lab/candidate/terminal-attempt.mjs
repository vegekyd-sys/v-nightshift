// Pre-merge integration: a private Gateway's real Workboard normalization,
// this branch's planner/decisions, and a synthetic SQLite operation ledger.
// No Agent is dispatched, and no supplier or production database is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WorkboardGatewayAdapter } from "../../packages/nightshift-core/src/workboard-gateway-adapter.mjs";

const { VLAB_CANDIDATE_RUNTIME: runtimeDir, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_STATE_DIR: stateDir, VLAB_CANDIDATE_DATA: dataDir } = process.env;
assert(runtimeDir && configPath && stateDir && dataDir, "a private VLab candidate is required");
const original = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(original.gateway?.port);
assert(Number.isInteger(port) && port > 0);
// No channels, cron, heartbeat, external plugins or isolated Agent pool. This
// Gateway only serves board RPCs; the shared VLab Gateway is never touched.
fs.writeFileSync(configPath, JSON.stringify({
  gateway: original.gateway,
  agents: { defaults: { workspace: path.join(dataDir, "workspace") } },
  channels: {}, cron: { enabled: false }, plugins: { allow: ["workboard"], entries: { workboard: { enabled: true }, deepseek: { enabled: false }, codex: { enabled: false } } },
}), { mode: 0o600 });
const privateTmp = fs.mkdtempSync("/tmp/ns-call-");
process.env.TMPDIR = privateTmp;
process.env.XDG_CACHE_HOME = path.join(dataDir, "cache");
fs.mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
const entry = path.join(runtimeDir, "openclaw/dist/index.js");
const gateway = spawn(process.execPath, [entry, "gateway", "--port", String(port)], {
  env: { ...process.env, OPENCLAW_GATEWAY_PORT: String(port), npm_config_cache: path.join(dataDir, "npm-cache") }, stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
for (const stream of [gateway.stdout, gateway.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => { errors = (errors + chunk).slice(-12000); });
}
const startupError = () => {
  let text = errors;
  const token = original.gateway?.auth?.token;
  if (typeof token === "string" && token) text = text.replaceAll(token, "[redacted]");
  return text.replace(/(token|api.?key|authorization|secret|bearer)([=: ]+)[^\s"']+/giu, "$1$2[redacted]").slice(-5000);
};
const workboard = new WorkboardGatewayAdapter({ board: "workflow-calls-candidate", configPath, entry, gatewayUrl: `ws://127.0.0.1:${port}` });

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seed = path.join(dataDir,"seed.json");
fs.writeFileSync(seed,JSON.stringify({apiVersion:"nightshift.versa.ai/v1alpha1",kind:"Workflow",metadata:{id:"seed",version:"1",name:"seed"},spec:{ownerAgentRole:"operator",stages:[{id:"hold",title:"hold",actor:"human",timeout:"1h"}]}}));
const listen=createServer();await new Promise(resolve=>listen.listen(0,"127.0.0.1",resolve));const serverPort=listen.address().port;await new Promise(resolve=>listen.close(resolve));
const server=spawn(process.execPath,[path.join(repo,"apps/nightshift-dashboard/server/index.mjs")],{env:{...process.env,NIGHTSHIFT_DATA_DIR:path.join(dataDir,"http"),NIGHTSHIFT_PORT:String(serverPort),NIGHTSHIFT_HOST:"127.0.0.1",NIGHTSHIFT_WORKFLOW_PATH:seed,NIGHTSHIFT_BOARD:"terminal-attempt-candidate",NIGHTSHIFT_GATEWAY_URL:`ws://127.0.0.1:${port}`,NIGHTSHIFT_OPENCLAW_ENTRY:entry,NIGHTSHIFT_NOTIFICATIONS_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});
for(const stream of [server.stdout,server.stderr]){stream.setEncoding("utf8");stream.on("data",chunk=>{errors=(errors+chunk).slice(-12000);});}
workboard.board="terminal-attempt-candidate";
try {
 const deadline=Date.now()+180000;
 while(true){assert(gateway.exitCode===null && server.exitCode===null,startupError());try{const r=await fetch(`http://127.0.0.1:${serverPort}/api/health`);if(r.ok)break;}catch{}if(Date.now()>deadline)throw Error(startupError());await new Promise(r=>setTimeout(r,500));}
 while(true){try{await workboard.connect();break;}catch(e){if(Date.now()>deadline)throw Error(startupError()+"\n"+e.message);await new Promise(r=>setTimeout(r,500));}}
 const {terminalAttemptHttpScenario}=await import("./terminal-attempt-http-scenario.mjs");
 console.log(JSON.stringify(await terminalAttemptHttpScenario({baseUrl:`http://127.0.0.1:${serverPort}`,workboard})));
} finally {
 try {await workboard.call("workboard.boards.archive",{id:workboard.board});} catch {}
 workboard.close();
 for(const child of [server,gateway]){child.kill("SIGTERM");if(child.exitCode===null && child.signalCode===null)await new Promise(resolve=>{const t=setTimeout(()=>{child.kill("SIGKILL");resolve();},10000);child.once("exit",()=>{clearTimeout(t);resolve();});});}
 fs.rmSync(privateTmp,{recursive:true,force:true});
}
