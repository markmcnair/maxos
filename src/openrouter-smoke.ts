import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";

interface SmokeResult {
  ok: boolean;
  durationMs: number;
  model: string;
  responseSnippet?: string;
  error?: string;
}

interface OpenRouterChoice { message?: { content?: string } }
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string };
}

function parseEnv(envContent: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of envContent.split("\n")) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const eq = trim.indexOf("=");
    if (eq < 0) continue;
    const key = trim.slice(0, eq).trim();
    const value = trim.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * End-to-end OpenRouter chat-completions probe. Posts a 1-token "pong" prompt
 * to the configured free model. PASSES iff:
 *   - 200 status
 *   - response body parses as JSON
 *   - choices[0].message.content is a non-empty string
 *
 * This is what the doctor's `--key valid` check doesn't cover — auth being
 * good doesn't mean the model is reachable / not rate-limited / not deprecated.
 */
export async function smokeOpenRouter(
  apiKey: string,
  model: string,
  timeoutMs = 15_000,
): Promise<SmokeResult> {
  const start = Date.now();
  // GLM-4.5-Air (and other reasoning models on OpenRouter) burn tokens on
  // internal reasoning even with `reasoning: { exclude: true }` — the flag
  // hides reasoning from the OUTPUT but the model still spends tokens
  // thinking. So the smoke test needs enough `max_tokens` headroom to
  // fit reasoning + actual answer. 250 is plenty for a "pong" response.
  // Non-reasoning models ignore the reasoning field, so this body is
  // always safe.
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    max_tokens: 250,
    temperature: 0,
    reasoning: { exclude: true },
  });

  return new Promise<SmokeResult>((resolve) => {
    const req = request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/markmcnair/maxos",
          "X-Title": "MaxOS scout smoke",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const dur = Date.now() - start;
          if (res.statusCode !== 200) {
            resolve({
              ok: false,
              durationMs: dur,
              model,
              error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
            });
            return;
          }
          try {
            const parsed = JSON.parse(data) as OpenRouterResponse;
            if (parsed.error) {
              resolve({
                ok: false,
                durationMs: dur,
                model,
                error: `API error: ${parsed.error.message ?? "unknown"}`,
              });
              return;
            }
            const content = parsed.choices?.[0]?.message?.content?.trim();
            if (!content) {
              resolve({
                ok: false,
                durationMs: dur,
                model,
                error: "empty response (no choices[0].message.content)",
              });
              return;
            }
            resolve({
              ok: true,
              durationMs: dur,
              model,
              responseSnippet: content.slice(0, 80),
            });
          } catch (err) {
            resolve({
              ok: false,
              durationMs: dur,
              model,
              error: `JSON parse: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        });
      },
    );
    req.on("error", (err) => {
      resolve({
        ok: false,
        durationMs: Date.now() - start,
        model,
        error: `network: ${err.message}`,
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        durationMs: Date.now() - start,
        model,
        error: `timeout after ${timeoutMs}ms`,
      });
    });
    req.write(body);
    req.end();
  });
}

const isCLI = process.argv[1]?.endsWith("openrouter-smoke.js");
if (isCLI) {
  (async () => {
    const maxosHome = process.env.MAXOS_HOME || `${process.env.HOME}/.maxos`;
    const envPath = `${maxosHome}/.env`;
    if (!existsSync(envPath)) {
      console.error("✗ .env not found at", envPath);
      process.exit(1);
    }
    const env = parseEnv(readFileSync(envPath, "utf-8"));
    const key = env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      console.error("✗ OPENROUTER_API_KEY not set in .env");
      process.exit(1);
    }
    const model = env.OPENROUTER_MODEL?.trim() || "z-ai/glm-4.5-air:free";

    console.log(`POST openrouter.ai/api/v1/chat/completions  model=${model}`);
    const result = await smokeOpenRouter(key, model);
    if (result.ok) {
      console.log(
        `✓ PASS (${result.durationMs}ms) — model responded: "${result.responseSnippet}"`,
      );
      process.exit(0);
    } else {
      console.log(`✗ FAIL (${result.durationMs}ms) — ${result.error}`);
      process.exit(1);
    }
  })();
}
