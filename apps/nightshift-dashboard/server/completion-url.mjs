import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createCompletionUrlChecker({
  fetchImpl = fetch,
  runner = execFileAsync,
  command = process.env.NIGHTSHIFT_LARK_COMMAND ?? "lark-cli",
  env = process.env,
  now = Date.now,
} = {}) {
  const verified = new Map();
  return async function checkCompletionUrl(value) {
    try {
      const url = new URL(value);
      const documentId = /^(?:\/docx\/)([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
      const larkHost = /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname);
      if (url.protocol !== "https:" || url.username || url.password) return false;
      if (larkHost && documentId) {
        // Private documents may return HTTP 404 to anonymous clients. Verify
        // the exact document with the service's existing authenticated CLI.
        const key = `${url.origin}/docx/${documentId}`;
        if ((verified.get(key) ?? 0) > now()) return true;
        const { stdout } = await runner(command, [
          "docs", "+fetch", "--doc", key, "--as", "user",
          "--scope", "outline", "--max-depth", "1", "--jq",
          "{ok: .ok, documentId: .data.document.document_id}",
        ], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
        const result = JSON.parse(stdout);
        if (result.ok !== true || result.documentId !== documentId) return false;
        if (verified.size >= 128) verified.clear();
        verified.set(key, now() + 30000);
        return true;
      }
      const response = await fetchImpl(value, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (response.ok) return true;
      if (![403, 405].includes(response.status)) return false;
      const fallback = await fetchImpl(value, { headers: { Range: "bytes=0-0" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
      await fallback.body?.cancel();
      return fallback.ok;
    } catch { return false; }
  };
}
