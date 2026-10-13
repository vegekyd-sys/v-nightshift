import { trustedUrl } from "./manifest.js";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function reviewContext(raw) {
  if (raw?.review?.enabled !== true) return null;
  const batchId = raw.review.sourceProjectId;
  if (typeof batchId !== "string" || !/^F-[A-Za-z0-9._-]{1,28}$/u.test(batchId) || raw.batchId !== batchId) throw new Error("这份验收清单缺少有效的测试批次。");
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 30) throw new Error("这份验收清单没有有效的视频。");
  const seen = new Set();
  const items = raw.items.map(item => {
    if (typeof item?.id !== "string" || !item.id.trim() || item.id.length > 80 || seen.has(item.id)) throw new Error("视频编号缺失或重复，暂时不能确认发布。");
    const url = trustedUrl(item.url);
    if (!url || url.username || url.password || url.port) throw new Error("有视频链接无效，暂时不能确认发布。");
    seen.add(item.id);
    return { id: item.id, title: String(item.title ?? ""), url: url.toString() };
  });
  return { batchId, items };
}

export function selectReviewItems(items, rejectedIds) {
  if (!Array.isArray(rejectedIds) || rejectedIds.some(id => typeof id !== "string")) throw new Error("不通过的视频清单格式不对。");
  const known = new Set(items.map(item => item.id));
  const rejected = new Set(rejectedIds);
  if (rejected.size !== rejectedIds.length || rejectedIds.some(id => !known.has(id))) throw new Error("不通过的视频编号不存在或重复。");
  return { accepted: items.filter(item => !rejected.has(item.id)), rejected: items.filter(item => rejected.has(item.id)) };
}

export async function manifestDigest(raw, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("请在安全的浏览器页面中确认发布。");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(raw)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function reviewEndpoint(batchId) {
  return `/api/delivery/${encodeURIComponent(batchId)}/intake`;
}
