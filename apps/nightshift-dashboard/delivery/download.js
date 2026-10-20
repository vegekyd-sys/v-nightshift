// Four bounded chunks at a time; never buffer the entire video for ZIP streaming.
// CORS must expose Content-Range and ETag. Otherwise use the original full GET.
export async function fetchDownload(url, bytes, {
  signal, fetcher = fetch, threshold = 8 * 1024 ** 2, chunkSize = 4 * 1024 ** 2,
} = {}) {
  signal?.throwIfAborted();
  const full = () => fetcher(url, { signal });
  if (!Number.isSafeInteger(bytes) || bytes < threshold) return full();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', abort);
  let probe;
  try {
    probe = await fetcher(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
  } catch (error) {
    cleanup(); if (signal?.aborted) throw error; return full();
  }
  if (probe.status === 200) { await probe.body?.cancel(); cleanup(); return full(); }
  const etag = probe.headers.get('ETag');
  const valid = probe.status === 206 && probe.headers.get('Content-Range') === `bytes 0-0/${bytes}` && /^"[^"\r\n]+"$/.test(etag || '');
  await probe.body?.cancel();
  if (!valid) { cleanup(); return full(); }
  let offset = 0;
  return new Response(new ReadableStream({
    async pull(stream) {
      try {
        controller.signal.throwIfAborted();
        const starts = Array.from({ length: Math.min(4, Math.ceil((bytes - offset) / chunkSize)) }, (_, i) => offset + i * chunkSize);
        const chunks = await Promise.all(starts.map(async start => {
          const end = Math.min(bytes - 1, start + chunkSize - 1);
          const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
          if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${bytes}` || response.headers.get('ETag') !== etag) {
            await response.body?.cancel();
            throw new Error('文件已变化或分段校验失败，请重新下载');
          }
          // Bound even a malformed/oversized response before it reaches the archive.
          const data = new Uint8Array(end - start + 1); let used = 0;
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read(); if (done) break;
              if (used + value.byteLength > data.length) throw new Error('下载分段长度不符，请重试');
              data.set(value, used); used += value.byteLength;
            }
            if (used !== data.length) throw new Error('下载分段不完整，请重试');
          } catch (error) { await reader.cancel().catch(() => {}); throw error; }
          return data;
        }));
        controller.signal.throwIfAborted();
        for (const data of chunks) { stream.enqueue(data); offset += data.length; }
        if (offset === bytes) { cleanup(); stream.close(); }
      } catch (error) { controller.abort(); cleanup(); stream.error(error); }
    },
    cancel(reason) { controller.abort(reason); cleanup(); },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(bytes), 'Content-Type': probe.headers.get('Content-Type') || 'application/octet-stream' } });
}
