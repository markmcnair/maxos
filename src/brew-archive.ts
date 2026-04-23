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

export interface ArchiveLearning {
  topic: string;
  day: number;
  breadcrumbUrl: string;
  alternative: string;
}

export interface DailyArchive {
  date: string;
  ai: ArchiveAI;
  prime: ArchivePrime | null;
  learning: ArchiveLearning | null;
  streak: number;
  feedbackAppliedFrom: string | null;
}

export function writeArchive(dir: string, snap: DailyArchive): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${snap.date}.json`), JSON.stringify(snap, null, 2));
}

export function readArchive(path: string): DailyArchive | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as DailyArchive;
}
