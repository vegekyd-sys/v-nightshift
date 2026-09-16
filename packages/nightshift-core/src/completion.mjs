export async function validateDeclaredCompletion({ checkUrl, instanceCreatedAt, loadArtifact, manifest, stage }) {
  const conditions = Array.isArray(stage?.completeWhen) ? stage.completeWhen : [];
  if (conditions.length === 0) return { output: {} };
  if (!manifest) throw new Error("Stage handoff is required for strict completion");

  const contracts = stage.outputContracts ?? {};
  const output = {};
  for (const entry of manifest.outputs ?? []) {
    output[entry.name] = await outputFacts({ artifact: entry.artifact, checkUrl, contract: contracts[entry.name] ?? {}, instanceCreatedAt, loadArtifact });
  }
  for (const [name, contract] of Object.entries(contracts)) {
    if (!output[name]) throw new Error(`Declared output ${name} is missing`);
    for (const [path, expected] of Object.entries(contract.equals ?? {})) {
      if (!sameValue(readPath(output[name], path), expected)) throw new Error(`output.${name}.${path} does not equal the Workflow contract`);
    }
    for (const [path, source] of Object.entries(contract.matches ?? {})) {
      if (!sameValue(readPath(output[name], path), readPath({ output }, source))) throw new Error(`output.${name}.${path} does not match ${source}`);
    }
  }
  for (const condition of conditions) {
    if (typeof condition !== "string" || !condition.startsWith("output.")) throw new Error(`Unsupported completion rule ${condition}`);
    if (!readPath({ output }, condition)) throw new Error(`Completion rule failed: ${condition}`);
  }
  return { output };
}

async function outputFacts({ artifact, checkUrl, contract, instanceCreatedAt, loadArtifact }) {
  const externalUrl = httpsUrl(artifact);
  if (contract.type === "https-url" || externalUrl) {
    if (!externalUrl) throw new Error("Output must reference an HTTPS URL");
    const allowedHosts = contract.allowedHosts ?? [];
    const hostAllowed = allowedHosts.length === 0 || allowedHosts.some((host) => hostMatches(externalUrl.hostname, host));
    if (!hostAllowed) throw new Error(`Output URL host ${externalUrl.hostname} is not allowed by the Workflow`);
    const reachable = await checkUrl(externalUrl.toString());
    return { accessible: reachable, hostAllowed, reachable, url: externalUrl.toString(), valid: hostAllowed && reachable, value: externalUrl.toString() };
  }

  const loaded = await loadArtifact(artifact);
  if (contract.type === "json" && !loaded.json) throw new Error("Output must reference a JSON artifact");
  const facts = loaded.json && typeof loaded.json === "object" && !Array.isArray(loaded.json)
    ? structuredClone(loaded.json)
    : parseTextFacts(loaded.text ?? "");
  facts.accessible = loaded.exists === true;
  facts.exists = loaded.exists === true;
  const createdAt = new Date(instanceCreatedAt).valueOf();
  if (Number.isFinite(loaded.mtimeMs) && Number.isFinite(createdAt)) facts.newForThisRun ??= loaded.mtimeMs >= createdAt;
  const items = Array.isArray(loaded.json?.contentItems) ? loaded.json.contentItems : Array.isArray(loaded.json?.items) ? loaded.json.items : null;
  if (items) {
    facts.hasAtLeastOneItem ??= items.length > 0;
    facts.everyItemHasStableIdAndTitle ??= items.length > 0 && items.every((item) => typeof item?.id === "string" && item.id.trim() && typeof item?.title === "string" && item.title.trim());
  }
  if (typeof loaded.json?.status === "string") facts.terminal ??= ["passed", "warning", "failed", "done", "complete", "completed"].includes(loaded.json.status.toLowerCase());
  return facts;
}

function parseTextFacts(text) {
  const facts = {};
  for (const match of String(text).matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(true|false)\b/gi)) facts[match[1]] = match[2].toLowerCase() === "true";
  return facts;
}

function readPath(root, path) {
  return String(path).split(".").filter(Boolean).reduce((value, key) => value?.[key], root);
}

function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch { return null; }
}

function hostMatches(actual, allowed) {
  const normalized = String(allowed ?? "").trim().toLowerCase().replace(/^\./, "");
  const hostname = actual.toLowerCase();
  return Boolean(normalized) && (hostname === normalized || hostname.endsWith(`.${normalized}`));
}
