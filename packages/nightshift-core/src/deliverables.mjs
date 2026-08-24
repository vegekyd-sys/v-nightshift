import { isAbsolute, normalize, sep } from "node:path";

const PATH_FIELDS = [
  ["proposal", "summaryPath"],
  ["video", "path"],
  ["video", "posterPath"],
  ["qc", "reportPath"],
  ["qc", "duplicateCheck", "reportPath"],
];

export function normalizeDeliverablesManifest(input, { instanceId, contentItemId = null }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Deliverables manifest must be an object");
  }
  if (input.version !== 1) throw new Error("Unsupported deliverables manifest version");
  if (input.instanceId !== instanceId) throw new Error("Deliverables manifest instance mismatch");
  if (contentItemId && input.contentItemId !== contentItemId) {
    throw new Error("Deliverables manifest content item mismatch");
  }

  const manifest = {
    version: 1,
    instanceId,
    contentItemId: contentItemId ?? optionalText(input.contentItemId, 160),
    title: cleanText(input.title, "Untitled delivery"),
    proposal: normalizeProposal(input.proposal),
    video: normalizeVideo(input.video),
    qc: normalizeQc(input.qc),
    review: normalizeReview(input.review),
  };
  for (const path of PATH_FIELDS) {
    const value = getPath(manifest, path);
    if (value) setPath(manifest, path, normalizeArtifactPath(value));
  }
  return manifest;
}

export function deliverableArtifactPaths(manifest) {
  const paths = new Set();
  for (const path of PATH_FIELDS) {
    const value = getPath(manifest, path);
    if (value) paths.add(value);
  }
  return paths;
}

export function normalizeArtifactPath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Artifact path must be a non-empty string");
  const normalized = normalize(value.trim());
  if (
    isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes("\0")
  ) {
    throw new Error("Artifact path must stay inside the instance directory");
  }
  return normalized.split(sep).join("/");
}

function normalizeProposal(value = {}) {
  return {
    title: cleanText(value.title, "策划与执行方案"),
    externalUrl: cleanUrl(value.externalUrl),
    summaryPath: optionalText(value.summaryPath),
  };
}

function normalizeVideo(value = {}) {
  if (!value.path) throw new Error("Deliverables video.path is required");
  return {
    title: cleanText(value.title, "最终成片"),
    path: value.path,
    posterPath: optionalText(value.posterPath),
    mimeType: value.mimeType === "video/webm" ? "video/webm" : "video/mp4",
    durationSeconds: positiveNumber(value.durationSeconds),
    width: positiveInteger(value.width),
    height: positiveInteger(value.height),
    sha256: optionalText(value.sha256, 128),
    projectUrl: cleanUrl(value.projectUrl),
  };
}

function normalizeQc(value = {}) {
  return {
    status: ["passed", "failed", "warning"].includes(value.status) ? value.status : "warning",
    reportPath: optionalText(value.reportPath),
    duplicateCheck: normalizeDuplicateCheck(value.duplicateCheck),
    summary: Array.isArray(value.summary)
      ? value.summary.slice(0, 12).map((entry) => cleanText(entry, "", 240)).filter(Boolean)
      : [],
  };
}

function normalizeDuplicateCheck(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    status: ["passed", "failed"].includes(value.status) ? value.status : "failed",
    method: optionalText(value.method, 120),
    threshold: unitNumber(value.threshold),
    maxDuplicateRatio: unitNumber(value.maxDuplicateRatio),
    duplicateRatio: unitNumber(value.duplicateRatio),
    comparedPairs: nonNegativeInteger(value.comparedPairs),
    reportPath: optionalText(value.reportPath),
  };
}

function normalizeReview(value = {}) {
  return {
    cardId: optionalText(value.cardId, 160),
    stageId: optionalText(value.stageId, 160),
    status: optionalText(value.status, 64),
  };
}

function getPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function setPath(value, path, next) {
  let current = value;
  for (const key of path.slice(0, -1)) current = current[key];
  current[path.at(-1)] = next;
}

function cleanText(value, fallback, max = 500) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function optionalText(value, max = 500) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function cleanUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function unitNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}
