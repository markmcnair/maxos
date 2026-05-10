import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Required sections per task type. Each entry is a regex the output must
 * contain (case-sensitive on emoji). Sections are checked in order; missing
 * ones are reported with their canonical names so the validator log is
 * scannable.
 */
export interface SchemaRule {
  /** Friendly name in the violation log. */
  name: string;
  /** Regex the output must contain at least once. */
  pattern: RegExp;
  /** True if missing this should be FAIL (vs WARN). */
  required: boolean;
}

export const MORNING_BRIEF_SCHEMA: SchemaRule[] = [
  { name: "header", pattern: /☀️\s*Morning Brief/, required: true },
  { name: "top-priority", pattern: /🪨\s*Top priority/i, required: true },
  { name: "since-yesterday", pattern: /📈\s*Since yesterday/i, required: false }, // optional — Sundays skip
  { name: "ghosted", pattern: /👻\s*Ghosted/i, required: true },
  { name: "first-presence", pattern: /📍\s*First presence/i, required: true },
  { name: "overnight", pattern: /🚨\s*Overnight/i, required: true },
  { name: "end-sentinel", pattern: /—\s*END BRIEF\s*—/, required: true },
];

export const SHUTDOWN_DEBRIEF_SCHEMA: SchemaRule[] = [
  { name: "header", pattern: /🌅\s*Shutdown Debrief/i, required: true },
  { name: "wins", pattern: /✅\s*Wins/i, required: true },
  { name: "ghosted", pattern: /👻\s*Ghosted/i, required: true },
  { name: "open-loops", pattern: /🔄\s*Open Loops/i, required: true },
  { name: "top-3", pattern: /🎯\s*Top 3 for Tomorrow/i, required: true },
  { name: "tomorrow-schedule", pattern: /📅\s*Tomorrow/i, required: true },
  { name: "closing-line", pattern: /Brain off|Family on/i, required: false },
];

export const MORNING_BREW_SCHEMA: SchemaRule[] = [
  { name: "header", pattern: /☕️?\s*Morning Brew/i, required: true },
  { name: "ai-section", pattern: /🧠\s*AI/i, required: false },
  { name: "prime-framework-section", pattern: /⚡️?\s*Prime Framework/i, required: false },
];

export interface SchemaViolation {
  task: string;
  missingRequired: string[];
  missingOptional: string[];
  totalChars: number;
}

/**
 * Validate `output` against the schema rules. Pure — returns the violation
 * shape without writing anywhere. Tested directly.
 */
export function validateAgainstSchema(
  output: string,
  schema: SchemaRule[],
  taskName: string,
): SchemaViolation {
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  for (const rule of schema) {
    if (rule.pattern.test(output)) continue;
    if (rule.required) missingRequired.push(rule.name);
    else missingOptional.push(rule.name);
  }
  return {
    task: taskName,
    missingRequired,
    missingOptional,
    totalChars: output.length,
  };
}

/**
 * Map a task slug or task-kit name to the right schema, or null if there
 * isn't one. The gateway's runOneShot post-processing uses this to decide
 * whether to validate at all.
 */
export function schemaForTask(taskName: string): SchemaRule[] | null {
  const lower = taskName.toLowerCase();
  if (lower.includes("morning-brief") || lower.includes("morningbrief")) return MORNING_BRIEF_SCHEMA;
  if (lower.includes("shutdown-debrief") || lower.includes("shutdowndebrief")) return SHUTDOWN_DEBRIEF_SCHEMA;
  if (lower.includes("morning-brew") || lower.includes("morningbrew")) return MORNING_BREW_SCHEMA;
  return null;
}

export interface SchemaViolationLogEntry extends SchemaViolation {
  ts: number;
}

/**
 * Append a violation to the JSONL log. Only writes when there's something
 * to flag (missingRequired or missingOptional non-empty). Best-effort —
 * never throws, never blocks delivery.
 */
export function logSchemaViolation(
  path: string,
  violation: SchemaViolation,
  now: number = Date.now(),
): void {
  if (violation.missingRequired.length === 0 && violation.missingOptional.length === 0) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entry: SchemaViolationLogEntry = { ts: now, ...violation };
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // never block delivery
  }
}

/** True iff the violation includes any REQUIRED section missing — needs an alert. */
export function isSchemaFailure(violation: SchemaViolation): boolean {
  return violation.missingRequired.length > 0;
}
