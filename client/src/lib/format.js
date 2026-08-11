const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayMonth = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayFull = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

const DAY = 86_400_000;

export function clockOf(value) {
  return value ? time.format(new Date(value)) : "";
}

/** Sidebar stamp: time today, weekday this week, date beyond that. */
export function stampOf(value) {
  if (!value) return "";
  const then = new Date(value);
  const age = Date.now() - then.getTime();
  if (age < DAY && then.getDate() === new Date().getDate()) return time.format(then);
  if (age < 6 * DAY) return weekday.format(then);
  return dayMonth.format(then);
}

/** Date divider inside a thread. */
export function dayLabelOf(value) {
  const then = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - DAY);
  if (then.toDateString() === today.toDateString()) return "Today";
  if (then.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFull.format(then);
}

export function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "Last seen" line under the peer's name. */
export function lastSeenOf(value) {
  if (!value) return "offline";
  const age = Date.now() - new Date(value).getTime();
  if (age < 60_000) return "last seen just now";
  if (age < 3_600_000) return `last seen ${Math.floor(age / 60_000)}m ago`;
  if (age < DAY) return `last seen ${Math.floor(age / 3_600_000)}h ago`;
  return `last seen ${dayMonth.format(new Date(value))}`;
}

export function bytesOf(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
