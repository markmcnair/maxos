import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ArchiveAI {
  headline: string;
  url: string;
  source: string;
  score: number;
}

export interface ArchivePrime {
  headline: string;
  built: boolean;
  prototypeUrl?: string;
  suggest?: string;
  failureReason?: string;
}

/**
 * The learning block as it is ACTUALLY written, across five years of drifting
 * writers. Only `topic` is load-bearing, and even that has been spelled `track`
 * (2026-04-28 → 2026-06-15). Everything else is optional because every one of
 * these fields has been absent from a real archive on disk.
 *
 * `day`, `breadcrumbUrl` and `alternative` belong to the multi-day learning
 * state machine that the brew RETIRED in June 2026 (`tasks/morning-brew.md`
 * Phase 2: "No state machine, no A/B, no reply parsing, no streak tracking").
 * They are kept readable for the 2026-04/05 archives, never required.
 */
export interface ArchiveLearning {
  topic?: string;
  track?: string;
  /** Deterministic slug of the topic, computed on write. See `topicKeyOf`. */
  topicKey?: string;
  url?: string;
  breadcrumbUrl?: string;
  day?: number;
  alternative?: string;
  /** Quarterly rock this pick serves, e.g. "ROCK-2026-Q3-coffee". */
  rock?: string;
  why?: string;
  [extra: string]: unknown;
}

export interface DailyArchive {
  date: string;
  ai: ArchiveAI;
  /**
   * Retired from the brew on 2026-06-17 along with the Prime Framework section
   * and the learning streak. Optional so that reading a modern archive is not
   * a type lie; do NOT reintroduce as required without also restoring the
   * sections in `tasks/morning-brew.md` that produce them.
   */
  prime?: ArchivePrime | null;
  learning: ArchiveLearning | null;
  streak?: number;
  feedbackAppliedFrom: string | null;
}

/** The learning subject, whatever the writer of the day decided to call it. */
export function learningTopicOf(a: DailyArchive | null | undefined): string | null {
  const l = a?.learning;
  if (!l) return null;
  const t = l.topic || l.track;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/**
 * Stable slug for a learning subject. Computed by the SCRIPT that owns the
 * file, never by the model that writes the brew: between 2026-06 and 2026-09
 * the model emitted a unique free-form slug every single day (102 archives,
 * 102 distinct keys), which is why no learning track ever reached the 3-day
 * threshold the nudger was built around.
 */
export function topicKeyOf(topic: string): string {
  return topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function writeArchive(dir: string, snap: DailyArchive): void {
  mkdirSync(dir, { recursive: true });
  const out: DailyArchive = { ...snap };
  const topic = learningTopicOf(snap);
  if (snap.learning && topic) {
    out.learning = { ...snap.learning, topicKey: topicKeyOf(topic) };
  }
  writeFileSync(join(dir, `${snap.date}.json`), JSON.stringify(out, null, 2));
}

export function readArchive(path: string): DailyArchive | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as DailyArchive;
}
