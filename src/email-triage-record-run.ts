import { homedir } from "node:os";
import { recordTrainingRun, type TrainingRunRecord } from "./email-triage-telemetry.js";

/**
 * CLI utility for the email-triage-training task to record a training
 * run with a guaranteed-valid schema. Invoked by the LLM as:
 *
 *   node dist/src/email-triage-record-run.js --json '{"date":...,"correctionsFound":...,...}'
 *
 * Exits 0 on success, non-zero with a stderr message on bad input.
 * The CLI shape (vs. asking the LLM to write the JSONL line directly)
 * makes the prompt instructions simpler ("call this command at the end")
 * and surfaces malformed payloads as exit codes the daemon can see in
 * the task_failed log line.
 */

interface CLIInput {
  date?: string;
  ranAt?: string;
  correctionsFound?: number;
  corrections?: TrainingRunRecord["corrections"];
  rulesAdded?: number;
  rulesRetired?: number;
  skillUpdated?: boolean;
  reason?: string;
  totalTriaged?: number;
  totalsByBucket?: TrainingRunRecord["totalsByBucket"];
  ruleCoverage?: TrainingRunRecord["ruleCoverage"];
}

export function validateAndNormalize(raw: unknown): TrainingRunRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("payload must be a JSON object");
  }
  const o = raw as CLIInput;
  if (typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) {
    throw new Error("`date` is required (YYYY-MM-DD)");
  }
  if (typeof o.ranAt !== "string") {
    throw new Error("`ranAt` is required (ISO 8601)");
  }
  if (typeof o.correctionsFound !== "number" || o.correctionsFound < 0) {
    throw new Error("`correctionsFound` is required (non-negative number)");
  }
  if (!Array.isArray(o.corrections)) {
    throw new Error("`corrections` is required (array, may be empty)");
  }
  if (typeof o.rulesAdded !== "number" || o.rulesAdded < 0) {
    throw new Error("`rulesAdded` is required (non-negative number)");
  }
  if (typeof o.rulesRetired !== "number" || o.rulesRetired < 0) {
    throw new Error("`rulesRetired` is required (non-negative number)");
  }
  if (typeof o.skillUpdated !== "boolean") {
    throw new Error("`skillUpdated` is required (boolean)");
  }
  return {
    date: o.date,
    ranAt: o.ranAt,
    correctionsFound: o.correctionsFound,
    corrections: o.corrections,
    rulesAdded: o.rulesAdded,
    rulesRetired: o.rulesRetired,
    skillUpdated: o.skillUpdated,
    reason: typeof o.reason === "string" ? o.reason : undefined,
    totalTriaged: typeof o.totalTriaged === "number" ? o.totalTriaged : undefined,
    totalsByBucket: o.totalsByBucket && typeof o.totalsByBucket === "object" ? o.totalsByBucket : undefined,
    ruleCoverage: o.ruleCoverage && typeof o.ruleCoverage === "object" ? o.ruleCoverage : undefined,
  };
}

const isCLI = process.argv[1]?.endsWith("email-triage-record-run.js");
if (isCLI) {
  const argv = process.argv;
  const i = argv.indexOf("--json");
  if (i < 0 || !argv[i + 1]) {
    console.error("usage: email-triage-record-run.js --json '<payload>'");
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argv[i + 1]);
  } catch (err) {
    console.error(`bad JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  let record: TrainingRunRecord;
  try {
    record = validateAndNormalize(parsed);
  } catch (err) {
    console.error(`schema error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const home = process.env.HOME ?? homedir();
  recordTrainingRun(home, record);
  console.log(`recorded training run for ${record.date} (${record.correctionsFound} corrections)`);
}
