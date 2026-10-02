import { downloadZip } from "client-zip";
import "./style.css";

const app = document.getElementById("app");
const base = location.pathname.replace(/\/+$/u, "");
const dataUrl = `${base}/data.json`;

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

const isWeChat = /MicroMessenger/iu.test(navigator.userAgent);
// Phones cannot write a zip straight to disk; building one in memory can run
// them out of it. They save the videos one by one.
const isPhone = /Android|iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const canStreamToDisk = typeof window.showSaveFilePicker === "function";
// Without writing straight to disk the archive is built in memory first.
const IN_MEMORY_LIMIT = 1.5 * 1024 ** 3;

load();

async function load() {
  try {
    const response = await fetch(dataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 404 ? "这个交付链接不存在或已失效。" : "交付信息暂时无法载入，请稍后刷新。");
    render(await response.json());
  } catch (error) {
    app.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  } finally {
    app.removeAttribute("aria-busy");
  }
}

function render(delivery) {
  document.title = `${delivery.title} · 视频交付`;
  const count = delivery.items.length;
  const totalBytes = delivery.totalBytes || delivery.items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  app.innerHTML = `
    <header class="hero">
      <div>
        <p class="eyebrow">视频交付 · ${escapeHtml(formatDate(delivery.deliveredAt))}</p>
        <h1>${escapeHtml(delivery.title)}</h1>
        <p class="meta">${count} 条视频${totalBytes ? ` · 共 ${formatBytes(totalBytes)}` : ""}</p>
      </div>
      <div class="actions">
        <button class="primary" id="download-all" type="button">${ICON_SAVE.replace("<svg", '<svg width="18" height="18"')}<span>下载全部</span></button>
        <div class="progress" id="progress" hidden>
          <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
          <div class="progress-text"><span id="progress-label"></span><button class="quiet" id="cancel" type="button">取消</button></div>
        </div>
        <button class="quiet" id="copy" type="button">复制交付链接</button>
      </div>
    </header>
    ${isWeChat ? '<p class="notice">微信里无法下载文件。请点右上角「···」，选择「在浏览器打开」后再下载。</p>' : ""}
    ${!isWeChat && isPhone ? '<p class="notice">在手机上，「下载全部」会把视频逐条保存。</p>' : ""}
    <section class="grid">
      ${delivery.items.map((item, index) => tile(item, index)).join("")}
    </section>
    <footer class="foot">视频在线播放，原画质下载。</footer>
  `;
  wire(delivery);
}

function tile(item, index) {
  const meta = [formatDuration(item.durationSec), item.bytes ? formatBytes(item.bytes) : null].filter(Boolean).join(" · ");
  return `
    <article class="tile" data-index="${index}">
      <div class="frame">
        <video preload="none" playsinline muted hidden data-src="${escapeAttr(item.url)}" data-poster-at="${posterAt(item.durationSec)}"></video>
        <button class="play" type="button" aria-label="播放 ${escapeAttr(item.title)}"><span>${ICON_PLAY}</span></button>
        <span class="index">${String(index + 1).padStart(2, "0")}</span>
      </div>
      <div class="caption">
        <div>
          <h2 title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</h2>
          ${meta ? `<p>${escapeHtml(meta)}</p>` : ""}
        </div>
        <button class="save" type="button" aria-label="下载这一条" title="下载这一条">${ICON_SAVE}</button>
      </div>
    </article>`;
}

function wire(delivery) {
  const tiles = [...app.querySelectorAll(".tile")];
  // A poster frame for tiles on screen; the full video only when played.
  const observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = entry.target.querySelector("video");
      if (!video.src) {
        video.preload = "metadata";
        video.src = `${video.dataset.src}#t=${video.dataset.posterAt}`;
        video.hidden = false;
      }
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "300px 0px" }) : null;

  tiles.forEach((element, index) => {
    const video = element.querySelector("video");
    const play = element.querySelector(".play");
    if (observer) observer.observe(element);
    else { video.preload = "metadata"; video.src = `${video.dataset.src}#t=${video.dataset.posterAt}`; video.hidden = false; }
    play.addEventListener("click", () => {
      if (!video.src) video.src = video.dataset.src;
      video.hidden = false;
      video.muted = false;
      video.controls = true;
      play.remove();
      element.querySelector(".index")?.remove();
      for (const other of app.querySelectorAll("video")) if (other !== video) other.pause();
      video.play().catch(() => {});
    });
    video.addEventListener("play", () => {
      for (const other of app.querySelectorAll("video")) if (other !== video) other.pause();
    });
    element.querySelector(".save").addEventListener("click", (event) => saveOne(delivery.items[index], event.currentTarget));
  });

  app.querySelector("#copy").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(location.href.split("#")[0]);
      button.textContent = "已复制";
    } catch {
      button.textContent = location.href.split("#")[0];
    }
    setTimeout(() => { button.textContent = "复制交付链接"; }, 2000);
  });

  app.querySelector("#download-all").addEventListener("click", () => downloadAll(delivery));
}

async function saveOne(item, button) {
  if (button.dataset.state === "busy") return;
  button.dataset.state = "busy";
  try {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(String(response.status));
    saveBlob(await response.blob(), item.fileName);
    button.dataset.state = "done";
    button.innerHTML = ICON_DONE;
  } catch {
    // The browser can still save it from its own player.
    window.open(item.url, "_blank", "noopener");
    delete button.dataset.state;
  }
}

let running = null;

async function downloadAll(delivery) {
  if (running) return;
  const button = app.querySelector("#download-all");
  const progress = app.querySelector("#progress");
  const bar = app.querySelector("#progress-bar");
  const label = app.querySelector("#progress-label");
  const total = delivery.totalBytes || delivery.items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const controller = new AbortController();
  running = controller;
  let received = 0;
  let current = 0;
  const update = () => {
    const share = total ? Math.min(1, received / total) : current / delivery.items.length;
    bar.style.width = `${(share * 100).toFixed(1)}%`;
    label.textContent = `第 ${Math.min(current, delivery.items.length)} / ${delivery.items.length} 条 · ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}`;
  };
  const finish = (text) => {
    running = null;
    button.disabled = false;
    button.querySelector("span").textContent = text ?? "下载全部";
    setTimeout(() => { progress.hidden = true; button.querySelector("span").textContent = "下载全部"; }, text ? 2600 : 0);
  };
  app.querySelector("#cancel").onclick = () => controller.abort();

  const counted = (response) => {
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(stream) {
        const { done, value } = await reader.read();
        if (done) { stream.close(); return; }
        received += value.byteLength;
        update();
        stream.enqueue(value);
      },
      cancel(reason) { reader.cancel(reason); },
    }), { headers: response.headers });
  };
  async function* files() {
    for (const item of delivery.items) {
      current += 1;
      update();
      const response = await fetch(item.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`第 ${current} 条下载失败（${response.status}）`);
      yield { name: item.fileName, lastModified: new Date(delivery.deliveredAt), input: counted(response) };
    }
  }

  try {
    if (isPhone || (!canStreamToDisk && total > IN_MEMORY_LIMIT)) {
      // One file at a time: no archive has to fit in memory.
      button.disabled = true;
      progress.hidden = false;
      for (const item of delivery.items) {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        current += 1;
        update();
        const response = await fetch(item.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`第 ${current} 条下载失败（${response.status}）`);
        saveBlob(await counted(response).blob(), item.fileName);
      }
      finish("已全部保存");
      return;
    }
    let writable = null;
    if (canStreamToDisk) {
      const handle = await window.showSaveFilePicker({
        suggestedName: delivery.archiveName || "videos.zip",
        types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
      });
      writable = await handle.createWritable();
    }
    button.disabled = true;
    progress.hidden = false;
    update();
    const archive = downloadZip(files());
    if (writable) {
      await archive.body.pipeTo(writable, { signal: controller.signal });
    } else {
      saveBlob(await archive.blob(), delivery.archiveName || "videos.zip");
    }
    received = total;
    update();
    finish("下载完成");
  } catch (error) {
    if (error?.name === "AbortError") finish("已取消");
    else if (error?.name === "NotAllowedError" || error?.name === "SecurityError") finish();
    else { label.textContent = error?.message || "下载中断，请重试"; finish("重试下载全部"); }
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Short videos open on a fade from black; a frame a little in shows the content.
function posterAt(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(1.5, seconds * 0.1).toFixed(2) : "1.5";
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
