import { readFile } from "node:fs/promises";

// Only the machine that runs the Gateway is relevant. Remote Gateway users
// retain the Gateway latency/pool gate rather than probing the dashboard host.
export function createHostPressureProbe({ gatewayUrl, platform = process.platform, read = readFile, now = Date.now } = {}) {
  let local = false;
  try { local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(gatewayUrl).hostname); } catch {}
  const enabled = platform === "linux" && local;
  let previous = null;
  return async () => {
    if (!enabled) return { enabled: false, blocked: false, reason: "Gateway host metrics unavailable on this host" };
    try {
      const [memory, vm, memoryPsi, ioPsi] = await Promise.all([
        read("/proc/meminfo", "utf8"), read("/proc/vmstat", "utf8"),
        read("/proc/pressure/memory", "utf8"), read("/proc/pressure/io", "utf8"),
      ]);
      const at = now();
      const metric = (text, name) => {
        const value = Number(text.match(new RegExp(`^${name}:?\\s+(\\d+)`, "m"))?.[1]);
        if (!Number.isFinite(value)) throw new Error(`Missing host metric ${name}`);
        return value;
      };
      const psi = text => {
        const value = Number(text.match(/^full\s+avg10=([\d.]+)/m)?.[1]);
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Invalid host pressure metric");
        return value;
      };
      const totalKiB = metric(memory, "MemTotal"), availableKiB = metric(memory, "MemAvailable"), swapOutPages = metric(vm, "pswpout");
      if (totalKiB <= 0 || availableKiB > totalKiB) throw new Error("Invalid host memory accounting");
      const memoryFullAvg10 = psi(memoryPsi), ioFullAvg10 = psi(ioPsi);
      const elapsed = previous ? at - previous.at : null;
      const warm = elapsed !== null && elapsed > 0 && elapsed <= 15_000 && swapOutPages >= previous.swapOutPages;
      const swapOutPagesPerSecond = warm ? (swapOutPages - previous.swapOutPages) * 1000 / elapsed : null;
      previous = { at, swapOutPages };
      const reasons = [];
      if (!warm) reasons.push("host sample warming up");
      if (availableKiB < Math.max(2 * 1024 * 1024, totalKiB * 0.15)) reasons.push("low available memory");
      if (memoryFullAvg10 >= 1) reasons.push("memory reclaim stalls");
      if (ioFullAvg10 >= 20) reasons.push("disk I/O stalls");
      if (swapOutPagesPerSecond !== null && swapOutPagesPerSecond >= 1024) reasons.push("active swap-out");
      return { enabled: true, at: new Date(at).toISOString(), blocked: reasons.length > 0, reason: reasons.join("; ") || null,
        availableMiB: Math.round(availableKiB / 1024), totalMiB: Math.round(totalKiB / 1024), memoryFullAvg10, ioFullAvg10, swapOutPagesPerSecond };
    } catch (error) {
      previous = null;
      return { enabled: true, blocked: true, reason: `host pressure probe failed: ${error.message}` };
    }
  };
}
