/**
 * Import ChatGPT conversation history into MaxOS.
 *
 * Usage:
 *   npx tsx scripts/import-chatgpt.ts <path-to-export.zip-or-directory>
 *
 * Accepts either:
 *   - The OpenAI export ZIP (contains conversations.json + other files)
 *   - An already-unzipped directory
 *
 * Produces one markdown file per conversation under
 *   $MAXOS_HOME/vault/chatgpt-history/YYYY/MM/<slug>.md
 *
 * Then runs `qmd update` so the new files become searchable via
 * semantic memory on the next embed tick.
 */
import { readFileSync, existsSync, mkdirSync, mkdtempSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  exportToFiles,
  extractCustomInstructions,
  formatCustomInstructionsBlock,
  parseChatGPTExport,
  type ChatGPTConversation,
} from "../src/chatgpt-import.js";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: import-chatgpt <path-to-export.zip-or-directory>");
    process.exit(1);
  }

  if (!existsSync(arg)) {
    console.error(`Path not found: ${arg}`);
    process.exit(1);
  }

  let sourceDir = arg;
  const stat = statSync(arg);

  if (stat.isFile()) {
    if (!arg.toLowerCase().endsWith(".zip")) {
      console.error("File path must end with .zip");
      process.exit(1);
    }
    const tmp = mkdtempSync(join(tmpdir(), "chatgpt-unzip-"));
    console.log(`Unzipping export to ${tmp}...`);
    try {
      execFileSync("unzip", ["-q", arg, "-d", tmp], { stdio: "inherit" });
    } catch {
      console.error("unzip failed — make sure the zip is valid.");
      process.exit(1);
    }
    sourceDir = tmp;
  } else if (!stat.isDirectory()) {
    console.error("Path must be a .zip file or a directory");
    process.exit(1);
  }

  const conversationsPath = join(sourceDir, "conversations.json");
  if (!existsSync(conversationsPath)) {
    console.error(
      `conversations.json not found in ${sourceDir}. This doesn't look like a ChatGPT export.`,
    );
    process.exit(1);
  }

  console.log("Parsing conversations.json...");
  const raw = JSON.parse(readFileSync(conversationsPath, "utf-8")) as unknown[];
  if (!Array.isArray(raw)) {
    console.error("conversations.json does not contain a top-level array.");
    process.exit(1);
  }
  console.log(`Found ${raw.length} conversations in the export.`);

  const maxosHome = process.env.MAXOS_HOME ?? join(homedir(), ".maxos");
  const outDir = join(maxosHome, "vault", "chatgpt-history");
  mkdirSync(outDir, { recursive: true });

  console.log(`Writing markdown to ${outDir}...`);
  const result = await exportToFiles(raw, outDir);
  console.log(`Imported ${result.filesWritten} conversations (${result.skipped} malformed/archived skipped).`);

  // Extract custom instructions (the user's "About me" / "How I want you to respond")
  // and append to USER.md. These live as repeated system messages across
  // conversations, so the parser looks for the most common substantive one.
  const conversations = parseChatGPTExport(raw, { skipArchived: true });
  const ci = extractCustomInstructions(conversations);
  if (ci) {
    const userMdPath = join(maxosHome, "workspace", "USER.md");
    const block = formatCustomInstructionsBlock(ci);
    if (existsSync(userMdPath)) {
      appendFileSync(userMdPath, block);
      console.log(`Appended custom instructions (${ci.occurrences} occurrences) to ${userMdPath}`);
    } else {
      // workspace may not exist yet (user is mid-onboarding). Stash for later pickup.
      mkdirSync(join(maxosHome, "workspace"), { recursive: true });
      writeFileSync(userMdPath, `# User Profile\n${block}`, "utf-8");
      console.log(`Created ${userMdPath} with imported custom instructions.`);
    }
  } else {
    console.log("No custom-instructions system message detected in export (common for older accounts).");
  }

  // Trigger QMD re-index so the new content becomes searchable.
  try {
    console.log("Re-indexing QMD keyword search (fast)...");
    execFileSync("qmd", ["update"], { stdio: "inherit" });

    // Fire vector embedding in the background so it doesn't block onboarding.
    // Semantic search for imported history lights up once this finishes
    // (~20-45 min depending on export size). Detach + unref so it survives
    // our parent process exiting.
    console.log("Kicking off vector embedding in the background...");
    const child = spawn("qmd", ["embed"], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // qmd missing or failed to launch — silent, keyword search still works
    });
    child.unref();
    console.log("Embeddings baking in the background. Keyword search works now; semantic search lights up in ~20-45 min.");
  } catch {
    console.warn(
      "qmd update failed — qmd may not be installed. Files are written; install QMD and run `qmd update && qmd embed` later to enable semantic search.",
    );
  }

  console.log(`\nDone. Your ChatGPT history lives at: ${outDir}`);
}

main().catch((err) => {
  console.error("Import failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
