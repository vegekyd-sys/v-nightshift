// A project's delivery page: every finished video at its CDN link, opened by
// an unguessable token. The page streams from the CDN and zips in the viewer's
// browser, so delivery no longer packs a gigabyte zip on V (Tianyi,
// 2026-10-02: the zip took time and disk, everyone downloaded the whole
// package, and a Windows-illegal name in it hid 14 of 20 videos on 2026-09-30).

import { randomBytes } from "node:crypto";

export const DEFAULT_DELIVERY_HOSTS = Object.freeze(["cdn.makaron.app"]);
const URL_FIELDS = ["sourceUrl", "videoUrl", "publicUrl", "cdnUrl", "url"];

export function newDeliveryToken() {
  return randomBytes(16).toString("base64url");
}

// "广东哆比 阿拉伯语 20条（下载交付）" -> "广东哆比 阿拉伯语 20条"
export function deliveryTitle(name) {
  return String(name ?? "").replace(/\s*[（(]\s*下载交付\s*[)）]\s*$/u, "").trim() || "交付";
}

// A name every system accepts: Windows refuses < > : " / \ | ? * and control
// characters, and trailing dots or spaces.
export function deliveryFileName(title, id, extension = "mp4") {
  const clean = String(title ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  const short = Array.from(clean).slice(0, 60).join("").trim() || "video";
  const suffix = String(id ?? "").replace(/[^A-Za-z0-9_-]/gu, "").slice(-12);
  return `${short}${suffix ? ` ${suffix}` : ""}.${extension}`;
}

export function finishedAssetUrl(asset) {
  for (const field of URL_FIELDS) {
    const value = asset?.[field];
    if (typeof value === "string" && /^https:\/\//iu.test(value)) return value;
  }
  const listed = Array.isArray(asset?.publicUrls) ? asset.publicUrls.find((value) => /^https:\/\//iu.test(value)) : null;
  return listed ?? null;
}

// The provider URL a paid produce call recorded on the ledger when it
// succeeded. Most produce stages write only the video file; on V on 2026-10-02
// 19 of DL-0930-01's 20 items had no finishedAsset.json, and every one had its
// Makaron videoUrl on the ledger.
export function ledgerVideoUrl(operations, contentItemId, stageId = "produce") {
  const settled = operations
    .filter((operation) => operation.contentItemId === contentItemId && operation.stageId === stageId && operation.status === "succeeded")
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  for (const operation of settled) {
    const url = finishedAssetUrl(operation.result ?? null);
    if (url) return url;
  }
  return null;
}

// Builds the page's manifest from the project's finished videos. Each video
// must be reachable on an allowed host at the same size as the file the
// project validated; anything else is listed in `missing` with the reason, and
// the caller (the delivery stage's Agent) uploads that file and passes its URL
// in `sources`.
//
// readAsset(itemId) -> { asset, bytes, ledgerUrl } | null
//   asset: finishedAsset.json beside the video, if any; bytes: the validated
//   video's size on disk; ledgerUrl: the URL its paid call recorded.
// probe(url) -> { ok, bytes, status }            (a HEAD request)
export async function buildDeliveryManifest({
  instance,
  contentItems,
  skippedIds = new Set(),
  readAsset,
  probe,
  sources = {},
  allowedHosts = DEFAULT_DELIVERY_HOSTS,
  now = new Date(),
}) {
  const items = [];
  const missing = [];
  for (const item of contentItems) {
    if (skippedIds.has(item.id)) continue;
    const found = await readAsset(item.id);
    if (!found || (!found.asset && !found.bytes)) {
      missing.push({ id: item.id, title: item.title, reason: "no finished video found (produce handoff)" });
      continue;
    }
    const asset = found.asset ?? {};
    const url = sources[item.id] ?? finishedAssetUrl(asset) ?? found.ledgerUrl ?? null;
    if (!url) {
      missing.push({ id: item.id, title: item.title, reason: "the finished video has no public URL: upload it and pass --source" });
      continue;
    }
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      missing.push({ id: item.id, title: item.title, reason: `not a URL: ${url}` });
      continue;
    }
    if (!url.startsWith("https://") || !allowedHosts.includes(host)) {
      missing.push({ id: item.id, title: item.title, reason: `host ${host} is not an allowed delivery host (${allowedHosts.join(", ")})` });
      continue;
    }
    const expected = Number(found.bytes ?? asset.bytes);
    const head = await probe(url);
    if (!head?.ok) {
      missing.push({ id: item.id, title: item.title, reason: `the URL does not answer (${head?.status ?? "no response"})` });
      continue;
    }
    if (Number.isFinite(expected) && expected > 0 && Number(head.bytes) !== expected) {
      missing.push({ id: item.id, title: item.title, reason: `the URL serves ${head.bytes} bytes, the finished video is ${expected}: it is not the same file, upload the finished video` });
      continue;
    }
    items.push({
      id: item.id,
      title: item.title ?? item.id,
      url,
      fileName: deliveryFileName(item.title, item.id),
      bytes: Number.isFinite(expected) && expected > 0 ? expected : Number(head.bytes) || null,
      durationSec: Number(asset.durationSec ?? asset.duration ?? found.durationSec) || null,
      resolution: typeof asset.resolution === "string" ? asset.resolution : found.resolution ?? null,
    });
  }
  const manifest = {
    version: 1,
    project: {
      id: instance.id,
      title: deliveryTitle(instance.name ?? instance.id),
      deliveredAt: now.toISOString(),
    },
    items,
    totalBytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
  };
  return { manifest, missing };
}

// The public form of a delivery: what the page shows, nothing internal.
export function publicDelivery(delivery) {
  const { project, items, totalBytes } = delivery.manifest;
  return {
    title: project.title,
    deliveredAt: delivery.updatedAt ?? project.deliveredAt,
    totalBytes,
    archiveName: deliveryFileName(project.title, "", "zip"),
    items: items.map(({ title, url, fileName, bytes, durationSec, resolution }) => ({ title, url, fileName, bytes, durationSec, resolution })),
  };
}
