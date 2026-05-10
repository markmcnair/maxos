import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { runAllChecks, type CheckResult } from "./doctor.js";
import { summarizeViolations } from "./voice-violations-summary.js";
import { readAndSummarize } from "./outbound-log.js";
import { summarizeForDigest, formatDigestLine } from "./email-triage-telemetry.js";
import { computePrecisionWindow, formatPrecisionDigestLine } from "./email-precision.js";

interface DigestInput {
  maxosHome: string;
  now: Date;
  doctorResults: CheckResult[];
}

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Compose a tight end-of-day digest. Surfaces only what's interesting:
 * health issues, loop counts, outbound stats, voice violations. Skips
 * boilerplate. Pure — caller passes resolved doctor results so this stays
 * testable without subprocess calls.
 */
export function buildDigestMessage(input: DigestInput): string {
  const { maxosHome, now, doctorResults } = input;
  const lines: string[] = [];
  lines.push(`📊 *MaxOS digest — ${fmtDate(now)}*`);
  lines.push("");

  // Health
  const fails = doctorResults.filter((r) => r.status === "FAIL");
  const warns = doctorResults.filter((r) => r.status === "WARN");
  if (fails.length > 0) {
    lines.push(`🚨 ${fails.length} FAIL · ${warns.length} warn (${doctorResults.length} checks)`);
    for (const f of fails) lines.push(`  ✗ ${f.name}: ${f.detail}`);
  } else if (warns.length > 0) {
    lines.push(`⚠️ ${warns.length} warning · ${doctorResults.length - warns.length} ok`);
    for (const w of warns) lines.push(`  ⚠ ${w.name}: ${w.detail}`);
  } else {
    lines.push(`✅ All ${doctorResults.length} doctor checks pass`);
  }

  // Loops
  const loopsPath = join(maxosHome, "workspace", "memory", "open-loops.json");
  let openCount = 0;
  if (existsSync(loopsPath)) {
    try {
      const raw = JSON.parse(readFileSync(loopsPath, "utf-8"));
      openCount = Array.isArray(raw) ? raw.length : 0;
    } catch {
      // ignore
    }
  }
  const stateFile = join(maxosHome, "workspace", "memory", "google-tasks-state.json");
  let mirrored = 0;
  if (existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
      mirrored = Object.keys(raw.loopToTask ?? {}).length;
    } catch {
      // ignore
    }
  }
  lines.push(`🔄 ${openCount} open loop${openCount === 1 ? "" : "s"} · ${mirrored} mirrored to Google Tasks`);

  // Outbound today
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  const outbound = readAndSummarize(
    join(maxosHome, "workspace", "memory", "outbound-events.jsonl"),
    since.getTime(),
    now.getTime(),
  );
  if (outbound.total === 0) {
    lines.push(`📤 outbound today: silent`);
  } else {
    const pct = Math.round(outbound.successRate * 100);
    const failSuffix = outbound.failed > 0 ? `, ${outbound.failed} failed` : "";
    lines.push(`📤 outbound today: ${outbound.total} sent, ${pct}% ok${failSuffix}`);
  }

  // Voice
  const vPath = join(maxosHome, "workspace", "memory", "voice-violations.jsonl");
  if (existsSync(vPath)) {
    const summary = summarizeViolations(readFileSync(vPath, "utf-8"), since.getTime(), now.getTime());
    if (summary.totalViolations === 0) {
      lines.push(`🎙️ voice today: clean`);
    } else {
      const top = summary.byPattern[0];
      const topNote = top ? `, top: "${top.pattern}" (${top.count}×)` : "";
      lines.push(`🎙️ voice today: ${summary.totalViolations} violation${summary.totalViolations === 1 ? "" : "s"}${topNote}`);
    }
  }

  // Email-triage training telemetry + precision — surfaces "training has
  // been silent for N nights" which is the exact failure mode that bit
  // Mark for 3 weeks before this telemetry landed (Round S, 2026-05-05).
  // Reads from $HOME/.config/email-triage/ since the training task
  // writes there, not under MAXOS_HOME.
  try {
    const userHome = process.env.HOME ?? homedir();
    const summary = summarizeForDigest(userHome, now.getTime(), 30);
    if (summary.runs > 0 || (summary.nightsSinceLastRun ?? 0) > 1) {
      lines.push(`📬 ${formatDigestLine(summary)}`);
    }
    const precision = computePrecisionWindow(userHome, now.getTime(), 30);
    if (!precision.insufficient && precision.totalEmails > 0) {
      lines.push(`   ${formatPrecisionDigestLine(precision)}`);
    }
  } catch {
    // Silent — telemetry being broken should never break the digest itself
  }

  // Tasks fired today
  const statePath = join(maxosHome, "state.json");
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const lastRun: Record<string, number> = state.scheduler?.lastRun ?? {};
      const firedToday = Object.values(lastRun).filter((ts) => ts >= since.getTime()).length;
      lines.push(`📅 ${firedToday} scheduled task${firedToday === 1 ? "" : "s"} fired today`);
    } catch {
      // ignore
    }
  }

  lines.push("");
  if (fails.length > 0 || warns.length > 0) {
    lines.push(`_Type /status detail for full breakdown, /status violations for voice log._`);
  } else {
    lines.push(`_All green. Brain off, family on. 🌙_`);
  }

  return lines.join("\n");
}

function postToDeliverTask(text: string, port = 18790, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ taskName: "maxos-digest", result: text });
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/deliver-task",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

const isCLI = process.argv[1]?.endsWith("maxos-digest.js");
if (isCLI) {
  (async () => {
    const maxosHome = process.env.MAXOS_HOME || `${process.env.HOME}/.maxos`;
    const doctorResults = await runAllChecks({ maxosHome, fast: true });
    const message = buildDigestMessage({
      maxosHome,
      now: new Date(),
      doctorResults,
    });
    await postToDeliverTask(message);
    // also echo to stdout so heartbeat log captures it
    console.log(message);
  })().catch((err) => {
    console.error("maxos-digest:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
