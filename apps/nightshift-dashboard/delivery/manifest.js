// A delivery page is a template filled by a manifest the Agent writes and
// uploads (Tianyi, 2026-10-02: the page belongs to the Workflow's template,
// not to the engine). The page is /deliver/?m=<manifest URL>.
//
// Manifest, version 1:
//   {
//     "version": 1,
//     "title": "客户 英语 20条",                        the page heading
//     "archiveName": "…zip",                           optional; the 「下载全部」 zip, else the title
//     "deliveredAt": "2026-10-02T08:00:00+08:00",      optional
//     "items": [
//       { "title": "…", "url": "https://cdn.makaron.app/…mp4",
//         "fileName": "…mp4", "bytes": 38513653, "durationSec": 20.1 }   only title and url required
//     ]
//   }
//
// Every name is the Agent's, taken as written (Tianyi, 2026-10-02: naming a
// file must never need a change here). The page only does what no name can
// choose: it replaces characters Windows refuses, and keeps two files in one
// zip from sharing a name.
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
// or spaces; its own unzip skips such entries without a word (on 2026-09-30
// a name like that hid 14 of 20 videos in a zip).
export function safeFileName(name) {
  return String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
}

function extensionOf(url) {
  const last = url.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot) : "";
}

// "a.mp4" → "a (2).mp4"
function numbered(name, n) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
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
    // Without a fileName the item's title names it, with the extension its URL has.
    const given = safeFileName(item.fileName) || `${safeFileName(title) || `${index + 1}`}${extensionOf(url)}`;
    let fileName = given;
    for (let n = 2; names.has(fileName.toLowerCase()); n += 1) fileName = numbered(given, n);
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
      archiveName: zipName(safeFileName(raw.archiveName) || safeFileName(title) || "视频交付"),
      totalBytes: items.every((item) => item.bytes) ? items.reduce((sum, item) => sum + item.bytes, 0) : null,
      items,
    },
    rejected,
  };
}

function zipName(name) {
  return /\.zip$/iu.test(name) ? name : `${name}.zip`;
}
