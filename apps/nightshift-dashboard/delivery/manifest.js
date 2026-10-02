// A delivery page is a template filled by a manifest the Agent writes and
// uploads (Tianyi, 2026-10-02: the page belongs to the Workflow's template,
// not to the engine). The page is /deliver/?m=<manifest URL>.
//
// Manifest, version 1:
//   {
//     "version": 1,
//     "title": "客户 英语 20条",
//     "archiveName": "DL 2026-10-02 客户 英语 20条 a1b2c3d4.zip",   optional; defaults to the title
//     "deliveredAt": "2026-10-02T08:00:00+08:00",      optional
//     "items": [
//       { "title": "…", "url": "https://cdn.makaron.app/…mp4",
//         "fileName": "…mp4", "bytes": 38513653, "durationSec": 20.1 }   only title and url required
//     ]
//   }
//
// Only manifests and videos on these hosts are shown, so nobody can use this
// domain to present arbitrary content.
export const TRUSTED_HOSTS = Object.freeze([
  "cdn.makaron.app",
  "sdyrtztrjgmmpnirswxt.supabase.co",
  "orywxdeppjtwckzqehpr.supabase.co",
]);

export function trustedUrl(value, hosts = TRUSTED_HOSTS) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && hosts.includes(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

// Windows refuses < > : " / \ | ? * and control characters, and trailing dots
// or spaces (on 2026-09-30 such a name hid 14 of 20 videos in a zip).
export function safeFileName(name, fallback = "video", extension = "mp4") {
  const clean = String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  const stem = clean.replace(new RegExp(`\\.${extension}$`, "iu"), "");
  const short = Array.from(stem).slice(0, 80).join("").trim() || fallback;
  return `${short}.${extension}`;
}

// Returns { delivery, rejected } or throws with a message for the viewer.
export function readManifest(raw, hosts = TRUSTED_HOSTS) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.items)) {
    throw new Error("交付清单格式不对。");
  }
  const rejected = [];
  const names = new Set();
  const items = [];
  raw.items.forEach((item, index) => {
    const url = trustedUrl(item?.url, hosts);
    if (!url) {
      rejected.push({ index, title: item?.title ?? null });
      return;
    }
    const title = String(item.title ?? "").trim() || `视频 ${index + 1}`;
    // Two items with the same name would overwrite each other in the zip.
    let fileName = safeFileName(item.fileName || title);
    for (let n = 2; names.has(fileName.toLowerCase()); n += 1) fileName = safeFileName(`${(item.fileName || title).replace(/\.mp4$/iu, "")} (${n})`);
    names.add(fileName.toLowerCase());
    items.push({
      title,
      url: url.toString(),
      fileName,
      bytes: Number.isFinite(Number(item.bytes)) && Number(item.bytes) > 0 ? Number(item.bytes) : null,
      durationSec: Number.isFinite(Number(item.durationSec)) && Number(item.durationSec) > 0 ? Number(item.durationSec) : null,
    });
  });
  const title = String(raw.title ?? "").trim() || "视频交付";
  return {
    delivery: {
      title,
      deliveredAt: raw.deliveredAt ?? null,
      // The zip has its own naming rule (康浩源, 2026-09-30), so it may differ from the heading.
      archiveName: safeFileName(String(raw.archiveName ?? "").trim() || title, "videos", "zip"),
      totalBytes: items.every((item) => item.bytes) ? items.reduce((sum, item) => sum + item.bytes, 0) : null,
      items,
    },
    rejected,
  };
}
