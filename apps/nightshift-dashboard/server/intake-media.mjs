import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { trustedUrl } from "../delivery/manifest.js";

const run = promisify(execFile);
export function createIntakeMediaChecker({ runner = run } = {}) {
  return async (inputs) => {
    const seen = new Set(), checks = [];
    for (const item of inputs.acceptedItems ?? []) {
      const url = trustedUrl(item.url);
      if (!url || url.username || url.password || url.port || seen.has(`${url.origin}${url.pathname}`)) throw new Error("确认视频链接无效或重复，不能入池。");
      seen.add(`${url.origin}${url.pathname}`);
      let probe;
      try {
        const result = await runner("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json", url.toString()], { timeout: 20000, maxBuffer: 128 * 1024 });
        probe = JSON.parse(result.stdout);
      } catch { throw new Error(`视频 ${item.id} 无法实测读取，未确认规格。`); }
      const stream = probe.streams?.[0];
      const rotation = Math.abs(Number(stream?.side_data_list?.[0]?.rotation ?? stream?.tags?.rotate ?? 0)) % 180;
      const width = rotation === 90 ? stream?.height : stream?.width;
      const height = rotation === 90 ? stream?.width : stream?.height;
      const duration = Number(probe.format?.duration);
      if (width !== 1080 || height !== 1920 || !Number.isFinite(duration) || duration <= 0) throw new Error(`视频 ${item.id} 不是可读的1080×1920成片，先取得原画导出，不入池。`);
      checks.push({ contentItemId: item.id, width, height, durationSeconds: duration });
    }
    if (!checks.length) throw new Error("没有可确认的视频。");
    return checks;
  };
}
