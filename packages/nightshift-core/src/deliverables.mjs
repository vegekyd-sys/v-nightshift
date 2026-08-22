import { isAbsolute, normalize, sep } from "node:path";

const PATH_FIELDS = [
  ["proposal", "summaryPath"],
  ["video", "path"],
  ["video", "posterPath"],
  ["qc", "reportPath"],
];

export function normalizeDeliverablesManifest(input, { instanceId }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Deliverables manifest must be an object");
  }
  if (input.version !== 1) throw new Error("Unsupported deliverables manifest version");
  if (input.instanceId !== instanceId) throw new Error("Deliverables manifest instance mismatch");

  const manifest = {
    version: 1,
    instanceId,
    title: cleanText(input.title, "Untitled delivery"),
    proposal: normalizeProposal(input.proposal),
    video: normalizeVideo(input.video),
    qc: normalizeQc(input.qc),
    review: normalizeReview(input.review),
  };
  for (const [section, field] of PATH_FIELDS) {
    const value = manifest[section]?.[field];
    if (value) manifest[section][field] = normalizeArtifactPath(value);
  }
  return manifest;
}

export function deliverableArtifactPaths(manifest) {
  const paths = new Set();
  for (const [section, field] of PATH_FIELDS) {
    const value = manifest[section]?.[field];
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
    summary: Array.isArray(value.summary)
      ? value.summary.slice(0, 12).map((entry) => cleanText(entry, "", 240)).filter(Boolean)
      : [],
  };
}

function normalizeReview(value = {}) {
  return {
    cardId: optionalText(value.cardId, 160),
    stageId: optionalText(value.stageId, 160),
    status: optionalText(value.status, 64),
  };
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
