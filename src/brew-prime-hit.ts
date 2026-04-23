import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrimeCandidate, PrimeScores } from "./brew-prime-candidates.js";

export interface Prototype {
  url: string;
  summary: string;
  tech: string[];
  repo: string;
}

export interface PrimeHit {
  date: string;
  candidate: PrimeCandidate;
  scores: PrimeScores;
  confidence: number;
  build: boolean;
  prototype?: Prototype;
  suggest?: string;
  attempted?: boolean;
  reason?: string;
  partial_work?: string;
}

export function writePrimeHit(path: string, hit: PrimeHit): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(hit, null, 2));
}

export function readPrimeHit(path: string): PrimeHit | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as PrimeHit;
}
