export interface PrimeCandidate {
  url: string;
  title: string;
  source: string;         // "x" | "producthunt" | "hn" | "yc" | "blog" | "github"
  summary: string;
  whatIfWeBuilt: string;  // 1-line idea for the prototype
}

export interface PrimeScores {
  createValue: number;
  removeToil: number;
  automate: number;
  activeFit: number;
}

export function scorePrime(s: PrimeScores): number {
  const raw = s.createValue * 0.35 + s.removeToil * 0.30 + s.automate * 0.25 + s.activeFit * 0.10;
  return Math.round(raw * 100) / 100;
}

export const CONFIDENCE_THRESHOLD = 4.2;

export function passesConfidenceGate(score: number): boolean {
  return score >= CONFIDENCE_THRESHOLD;
}
