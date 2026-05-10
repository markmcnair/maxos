/**
 * Permanent Granola integration (Round Y, 2026-05-10).
 *
 * Problem solved: the daemon's `claude -p` subprocess can't reach the
 * claude.ai-hosted Granola MCP (session-scoped OAuth). The granola CLI
 * was broken (refresh-chain mismatch). The plain `supabase.json` is
 * stale (desktop app moved to `supabase.json.enc`). This module reads
 * the encrypted file the desktop app keeps fresh and authenticates to
 * Granola's API directly. As long as Mark has the desktop app
 * installed and signed in (which he does — passwordless, the app keeps
 * itself authenticated forever), this works without re-auth.
 *
 * Three-layer decryption to get the access token:
 *   1. macOS Keychain entry "Granola Safe Storage / Granola Key" holds
 *      a base64-encoded random passphrase.
 *   2. PBKDF2-SHA1(passphrase, salt="saltysalt", iters=1003, keyLen=16)
 *      → AES-128-CBC key for Electron safeStorage.
 *   3. `storage.dek` = "v10" + safeStorage-encrypted base64(DEK).
 *      Decrypt with safeStorage key → base64 → 32-byte AES-256-GCM key.
 *   4. `supabase.json.enc` = IV(12) + ciphertext + tag(16). Decrypt
 *      with DEK using AES-256-GCM → fresh JSON.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

const GRANOLA_APP_DIR = join(homedir(), "Library", "Application Support", "Granola");
const STORAGE_DEK_PATH = join(GRANOLA_APP_DIR, "storage.dek");
const SUPABASE_ENC_PATH = join(GRANOLA_APP_DIR, "supabase.json.enc");

// Granola CLI v0.0.0 client-id strings (from CLI source).
const CLIENT_HEADERS = {
  "X-App-Version": "7.0.0",
  "X-Client-Version": "7.0.0",
  "X-Client-Type": "cli",
  "X-Client-Platform": "darwin",
  "X-Client-Architecture": "arm64",
  "X-Client-Id": "granola-cli-0.0.0",
  "User-Agent": "Granola/7.0.0 granola-cli/0.0.0 (macOS Darwin)",
};
const WORKOS_AUTH_URL = "https://api.workos.com/user_management/authenticate";
const GRANOLA_API_BASE = "https://api.granola.ai";

export interface GranolaTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: number; // Unix seconds
}

// ───── Layer 1: Electron safeStorage decryption ─────

function getSafeStoragePassword(): string {
  // macOS Keychain: service="Granola Safe Storage", account="Granola Key"
  return execFileSync("security", [
    "find-generic-password", "-w",
    "-s", "Granola Safe Storage",
    "-a", "Granola Key",
  ]).toString().trim();
}

function deriveSafeStorageKey(passphrase: string): Buffer {
  // Chromium OSCrypt: PBKDF2-SHA1, salt="saltysalt", 1003 iters, 16-byte key.
  return pbkdf2Sync(passphrase, "saltysalt", 1003, 16, "sha1");
}

function decryptSafeStorage(blob: Buffer, key: Buffer): Buffer {
  // Strip Electron's v10/v11 version prefix.
  let ciphertext = blob;
  if (blob.length >= 3 && (blob.slice(0, 3).toString() === "v10" || blob.slice(0, 3).toString() === "v11")) {
    ciphertext = blob.slice(3);
  }
  const iv = Buffer.alloc(16, 0x20); // 16 bytes of space — Chromium convention
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted;
}

// ───── Layer 2: DEK → supabase.json.enc decryption ─────

export function loadDek(): Buffer {
  const passphrase = getSafeStoragePassword();
  const safeKey = deriveSafeStorageKey(passphrase);
  const blob = readFileSync(STORAGE_DEK_PATH);
  const decoded = decryptSafeStorage(blob, safeKey);
  // The decrypted content is the base64 of the DEK (32 bytes).
  return Buffer.from(decoded.toString().trim(), "base64");
}

function decryptDataFile(filePath: string, dek: Buffer): string {
  const blob = readFileSync(filePath);
  const IV_LEN = 12;
  const TAG_LEN = 16;
  const iv = blob.slice(0, IV_LEN);
  const tag = blob.slice(blob.length - TAG_LEN);
  const ciphertext = blob.slice(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

// ───── Layer 3: Extract tokens + JWT decoding ─────

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT");
  const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
  return JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

export function readTokensFromDisk(): GranolaTokens {
  const dek = loadDek();
  const plain = decryptDataFile(SUPABASE_ENC_PATH, dek);
  const outer = JSON.parse(plain);
  if (typeof outer.workos_tokens !== "string") {
    throw new Error("supabase.json missing workos_tokens string");
  }
  const wt = JSON.parse(outer.workos_tokens);
  if (!wt.access_token || !wt.refresh_token) {
    throw new Error("workos_tokens missing access_token or refresh_token");
  }
  const payload = decodeJwtPayload(wt.access_token);
  const clientId = (payload.client_id as string) ?? "client_GranolaMac";
  const expiresAt = (payload.exp as number) ?? 0;
  return {
    accessToken: wt.access_token,
    refreshToken: wt.refresh_token,
    clientId,
    expiresAt,
  };
}

// ───── Token refresh via WorkOS ─────

const TOKEN_REFRESH_BUFFER_SEC = 60;

export function isExpiredOrSoon(t: GranolaTokens, now: number = Math.floor(Date.now() / 1000)): boolean {
  return t.expiresAt - TOKEN_REFRESH_BUFFER_SEC <= now;
}

export async function refreshTokens(t: GranolaTokens): Promise<GranolaTokens> {
  const res = await fetch(WORKOS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: t.clientId,
      grant_type: "refresh_token",
      refresh_token: t.refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; refresh_token: string };
  const payload = decodeJwtPayload(data.access_token);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    clientId: t.clientId,
    expiresAt: (payload.exp as number) ?? 0,
  };
}

/**
 * Get current valid tokens. Strategy:
 *   1. Read from disk (encrypted file desktop app keeps fresh).
 *   2. If access_token is still valid, return it.
 *   3. If expired, refresh via WorkOS. If refresh works, return new tokens
 *      (we don't write back — desktop app owns the storage).
 *   4. If refresh fails, fall back to re-reading disk (desktop app may
 *      have refreshed in the meantime).
 */
export async function getValidTokens(): Promise<GranolaTokens> {
  let t = readTokensFromDisk();
  if (!isExpiredOrSoon(t)) return t;
  try {
    return await refreshTokens(t);
  } catch (err) {
    // Re-read disk in case desktop app refreshed since our last read
    const fresh = readTokensFromDisk();
    if (!isExpiredOrSoon(fresh)) return fresh;
    throw new Error(`Granola tokens expired and refresh failed: ${err instanceof Error ? err.message : String(err)}. Open the Granola desktop app to refresh.`);
  }
}

// ───── Granola API client ─────

export interface GranolaMeeting {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  attendees?: Array<{ email?: string; name?: string }>;
  // Free-form: depends on Granola API shape. We pass through whatever we get.
  [key: string]: unknown;
}

export interface GranolaApiClient {
  getDocuments(opts?: { limit?: number; offset?: number; workspace_id?: string }): Promise<unknown>;
  getDocumentsBatch(ids: string[]): Promise<unknown>;
  getDocumentMetadata(id: string): Promise<unknown>;
  getDocumentTranscript(id: string): Promise<unknown>;
}

async function apiPost(endpoint: string, token: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${GRANOLA_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...CLIENT_HEADERS,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Granola API ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function createClient(): Promise<GranolaApiClient> {
  const tokens = await getValidTokens();
  return {
    getDocuments: (opts = {}) => apiPost("/v2/get-documents", tokens.accessToken, {
      include_last_viewed_panel: true, // AI summary panel
      limit: opts.limit ?? 30,
      offset: opts.offset ?? 0,
      ...(opts.workspace_id ? { workspace_id: opts.workspace_id } : {}),
    }),
    getDocumentsBatch: (ids) => apiPost("/v1/get-documents-batch", tokens.accessToken, {
      document_ids: ids,
      include_last_viewed_panel: true, // AI summary panel
    }),
    getDocumentMetadata: (id) => apiPost("/v1/get-document-metadata", tokens.accessToken, { document_id: id }),
    getDocumentTranscript: (id) => apiPost("/v1/get-document-transcript", tokens.accessToken, { document_id: id }),
  };
}

// ───── High-level helpers used by the granola-sync task ─────

/**
 * List meetings created/started on a specific local date (YYYY-MM-DD).
 * Returns Granola's raw document shape — caller filters/formats.
 */
export async function listMeetingsForDate(ymd: string): Promise<Array<Record<string, unknown>>> {
  const client = await createClient();
  const raw = await client.getDocuments({ limit: 50 }) as { docs?: unknown[]; documents?: unknown[] };
  const docs = (raw.docs ?? raw.documents ?? []) as Array<Record<string, unknown>>;
  return docs.filter((d) => {
    const created = (d.created_at ?? d.startedAt ?? d.start_time ?? d.updated_at ?? "") as string;
    if (!created) return false;
    return created.startsWith(ymd);
  });
}

// ───── ProseMirror → markdown helper for AI summary panel ─────

interface PmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: Array<{ type: string }>;
}

/**
 * Extract a markdown-ish plain-text representation of a Granola
 * "last_viewed_panel" content tree (ProseMirror nodes). Used to inline
 * the AI summary into the daily meeting-notes file.
 */
export function panelToMarkdown(content: unknown): string {
  function walk(node: PmNode | PmNode[] | undefined | null): string {
    if (!node) return "";
    if (Array.isArray(node)) return node.map(walk).join("");
    if (node.type === "text") return node.text ?? "";
    if (node.type === "heading") {
      const level = ((node.attrs?.level as number) ?? 2);
      return "\n" + "#".repeat(Math.min(6, Math.max(1, level))) + " " + walk(node.content) + "\n";
    }
    if (node.type === "paragraph") return walk(node.content) + "\n";
    if (node.type === "bullet_list" || node.type === "ordered_list") return "\n" + walk(node.content);
    if (node.type === "list_item") return "- " + walk(node.content).replace(/\n$/, "") + "\n";
    if (node.type === "hard_break") return "\n";
    if (node.content) return walk(node.content);
    return "";
  }
  const text = walk(content as PmNode);
  // Collapse 3+ newlines to 2
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export async function getMeetingDetails(ids: string[]): Promise<unknown> {
  if (ids.length === 0) return [];
  const client = await createClient();
  // Use batch endpoint for max 10 at a time
  const batches: unknown[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    try {
      batches.push(await client.getDocumentsBatch(slice));
    } catch (err) {
      batches.push({ batch: slice, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return batches;
}
