import { interpolate } from "./workflow.mjs";

/**
 * Timed release for a stage.
 *
 * A stage that must not run before a wall-clock moment declares `releaseAt`.
 * The planner resolves it to an epoch millisecond value and puts that on the
 * card as `scheduledAt`; the native Workboard then holds the card in its
 * `scheduled` status, refuses any early start, and promotes it to `ready`
 * during the next scoped dispatch at or after the moment.
 *
 * Two forms, because two different things are being expressed:
 *
 *   releaseAt: "${item.publishAt}"          one absolute instant, per item
 *   releaseAt:                                a recurring local wall clock
 *     dailyAt: "21:00"
 *     timezone: "America/New_York"
 *
 * The recurring form is the common one: "hold every finished video until 9pm
 * in New York". It is resolved against the zone on the target date, so it
 * stays correct across a daylight-saving transition. Writing a fixed UTC
 * offset instead would silently publish an hour early from 2 November.
 */

const DAILY_AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ReleaseScheduleError extends Error {}

export function resolveReleaseAt(spec, { instance = {}, contentItem = null, now = Date.now() } = {}) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec === "string") return absoluteRelease(spec, instance, contentItem);
  if (typeof spec === "object" && !Array.isArray(spec)) return recurringRelease(spec, instance, contentItem, now);
  throw new ReleaseScheduleError("releaseAt must be a timestamp expression or a { dailyAt, timezone } object");
}

function absoluteRelease(expression, instance, contentItem) {
  const resolved = resolve(expression, instance, contentItem);
  if (!resolved) return null;
  const at = Date.parse(resolved);
  if (!Number.isFinite(at)) {
    throw new ReleaseScheduleError(`releaseAt did not resolve to a timestamp: ${JSON.stringify(resolved)}`);
  }
  return at;
}

function recurringRelease(spec, instance, contentItem, now) {
  const timezone = resolve(spec.timezone, instance, contentItem);
  if (!timezone) throw new ReleaseScheduleError("releaseAt.timezone is required with releaseAt.dailyAt");
  assertTimezone(timezone);
  const dailyAt = resolve(spec.dailyAt, instance, contentItem);
  const match = DAILY_AT.exec(dailyAt ?? "");
  if (!match) throw new ReleaseScheduleError(`releaseAt.dailyAt must be HH:MM in 24-hour form, got ${JSON.stringify(dailyAt)}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  // An explicit date pins the release to one day. Without it the stage is held
  // until the next occurrence at or after the moment it became eligible, which
  // is what "publish tonight, or tomorrow night if it finished too late" means.
  const date = resolve(spec.date, instance, contentItem);
  if (date) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!parts) throw new ReleaseScheduleError(`releaseAt.date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
    return zonedTimeToEpoch(timezone, Number(parts[1]), Number(parts[2]), Number(parts[3]), hour, minute);
  }

  const today = zonedDateParts(timezone, now);
  let at = zonedTimeToEpoch(timezone, today.year, today.month, today.day, hour, minute);
  if (at <= now) {
    const next = zonedDateParts(timezone, at + 24 * 60 * 60 * 1000);
    at = zonedTimeToEpoch(timezone, next.year, next.month, next.day, hour, minute);
  }
  return at;
}

function resolve(expression, instance, contentItem) {
  if (expression === null || expression === undefined) return null;
  if (typeof expression !== "string") return expression;
  const value = interpolate(expression, {
    input: instance.inputs ?? {},
    instance,
    // The publish moment usually belongs to the video, not the project, so a
    // content-item stage can read its own item.
    item: contentItem ?? {},
  });
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ReleaseScheduleError(`releaseAt.timezone is not a known IANA zone: ${timezone}`);
  }
}

const ZONED = new Map();

function formatter(timezone) {
  let found = ZONED.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    ZONED.set(timezone, found);
  }
  return found;
}

function zonedDateParts(timezone, at) {
  const parts = Object.fromEntries(
    formatter(timezone).formatToParts(at).filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return { ...parts, hour: parts.hour % 24 };
}

function zoneOffsetMs(timezone, at) {
  const parts = zonedDateParts(timezone, at);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at;
}

/**
 * The epoch value of a wall-clock time in a zone.
 *
 * The offset has to be taken at the resulting instant, not at the naive UTC
 * guess, or a release near a transition lands an hour off. The second pass
 * covers the case where the guess and the answer sit on opposite sides of a
 * transition.
 */
function zonedTimeToEpoch(timezone, year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = wall - zoneOffsetMs(timezone, wall);
  const second = wall - zoneOffsetMs(timezone, first);
  return second;
}
