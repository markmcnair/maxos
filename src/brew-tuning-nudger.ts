import type { DailyArchive } from "./brew-archive.js";

export interface Nudge {
  key: string;
  delta: number;
  reason?: string;
}

const MAX_DELTA = 0.05;

export function proposeNudges(archives: DailyArchive[]): Nudge[] {
  const nudges: Nudge[] = [];

  const topicDays: Record<string, number> = {};
  for (const a of archives) {
    if (a.learning) topicDays[a.learning.topic] = (topicDays[a.learning.topic] ?? 0) + 1;
  }
  for (const [topic, days] of Object.entries(topicDays)) {
    if (days >= 3) {
      nudges.push({ key: topic, delta: 0.03, reason: `stuck ${days} days` });
    } else if (days === 1 && archives.some(a => a.learning?.topic === topic && a.streak > 0)) {
      nudges.push({ key: topic, delta: -0.03, reason: "switched away after day 1" });
    }
  }

  return nudges;
}

export function applyNudges(tuningMd: string, nudges: Nudge[]): string {
  let out = tuningMd;
  for (const n of nudges) {
    const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, n.delta));
    const re = new RegExp(`(^[-*]\\s+[^\\n]*${escapeRegex(n.key)}[^\\n]*:\\s*)([\\d.]+)`, "im");
    const m = out.match(re);
    if (!m) continue;
    const oldVal = parseFloat(m[2]);
    const newVal = Math.max(0, Math.min(1.0, Math.round((oldVal + clamped) * 100) / 100));
    out = out.replace(re, `$1${newVal}`);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
