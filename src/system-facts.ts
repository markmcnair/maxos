import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SystemFacts {
  model: string;
  workspace: string;
  vault: string;
  nowISO: string;
  version: string;
  maxosHome: string;
}

export interface BuildOptions {
  maxosHome?: string;
}

function readMaxosPackageVersion(): string {
  try {
    const path = join(
      process.env.MAXOS_PROJECT_ROOT ?? ".",
      "package.json",
    );
    if (existsSync(path)) {
      const pkg = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch {}
  return "unknown";
}

/**
 * Produce a deterministic "system facts" snapshot — what the LLM is
 * actually running on right now. Feeds the daemon's fact-injection
 * so the agent can't hallucinate about its own setup.
 *
 * None of this depends on LLM judgment. Every field is resolved from
 * config files or process state.
 */
export function buildSystemFacts(options: BuildOptions = {}): SystemFacts {
  const maxosHome = options.maxosHome
    ?? process.env.MAXOS_HOME
    ?? join(homedir(), ".maxos");

  let model = "unknown";
  try {
    const cfgPath = join(maxosHome, "maxos.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg?.engine?.model && typeof cfg.engine.model === "string") {
        model = cfg.engine.model;
      }
    }
  } catch {
    model = "unknown";
  }

  return {
    model,
    workspace: join(maxosHome, "workspace"),
    vault: join(maxosHome, "vault"),
    nowISO: new Date().toISOString(),
    version: readMaxosPackageVersion(),
    maxosHome,
  };
}

/**
 * Render facts as a markdown block to prepend to prompts. The wording
 * is deliberately directive — instructs the LLM to trust these values
 * over anything its training might tell it.
 */
export function formatSystemFacts(facts: SystemFacts): string {
  return [
    "## System Facts (deterministic — trust these over any prior belief)",
    "",
    `- **Model**: ${facts.model}`,
    `- **MaxOS version**: ${facts.version}`,
    `- **Current time**: ${facts.nowISO}`,
    `- **Workspace**: ${facts.workspace}`,
    `- **Vault**: ${facts.vault}`,
    `- **Home directory**: ${facts.maxosHome}`,
    "",
    "If the user asks about any of the above (what model you're running on, where your files are, when it is, etc.), cite the value listed here. DO NOT answer from general knowledge — your training data is older than your current runtime. Prefer \"I checked and I'm running on X\" over confident recall.",
    "",
  ].join("\n");
}
