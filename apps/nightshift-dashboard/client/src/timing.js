// A project's first card exists from creation but waits in the queue until a slot frees, so the
// time it was submitted is not when work began: show the wait separately from the work.
export function projectTiming(instance, now = Date.now()) {
  const submitted = Date.parse(instance.createdAt ?? "");
  const updated = Date.parse(instance.updatedAt ?? "");
  const working = Date.parse(instance.workStartedAt ?? "");
  if (!submitted) return "";
  const waited = working && working - submitted >= 10 * 60_000 ? ` · 排队 ${spanLabel(working - submitted)}` : "";
  if (instance.status === "done" && updated) return `${clockLabel(updated, now)} 交付 · 用时 ${spanLabel(updated - (working || submitted))}${waited}`;
  if (instance.status === "paused") return `${clockLabel(submitted, now)} 提交 · 已暂停`;
  if (!working) return `${clockLabel(submitted, now)} 提交 · 排队中 ${spanLabel(now - submitted)}`;
  return `${clockLabel(working, now)} 开工 · 已进行 ${spanLabel(now - working)}${waited}`;
}

export function clockLabel(at, now) {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function spanLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
