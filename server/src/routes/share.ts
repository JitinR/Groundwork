import { routeParam } from "../routeParams.js";
import { asyncHandler } from "../security.js";
import { Router } from "express";
import { decryptAesGcm, deriveVaultKey, sha256Hex } from "../crypto.js";
import { MASTER_KEY, PREVIOUS_MASTER_KEY } from "../config.js";
import { db, now } from "../db.js";

const router = Router();
const vaultKey = deriveVaultKey(MASTER_KEY);
const previousVaultKey = PREVIOUS_MASTER_KEY ? deriveVaultKey(PREVIOUS_MASTER_KEY) : null;

function decryptForUser(payloadJson: string, userId: string): string {
  const payload = JSON.parse(payloadJson) as { iv?: string; tag?: string; data?: string };
  if (!payload.iv || !payload.tag || !payload.data) return payloadJson;
  const aad = `groundwork:project:${userId}`;
  try {
    return decryptAesGcm(payload as { iv: string; tag: string; data: string }, vaultKey, aad);
  } catch (error) {
    if (!previousVaultKey) throw error;
    return decryptAesGcm(payload as { iv: string; tag: string; data: string }, previousVaultKey, aad);
  }
}

/* Public by design: the random, expiring token is the read-only capability. */
router.get("/:token", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  const row = (await db.prepare(
    `SELECT l.project_id, l.user_id, l.expires_at, p.name, p.project_type, p.design_data, p.width_mm, p.depth_mm, p.revision, p.created_at, p.updated_at, p.photo_file_id
     FROM project_share_links l JOIN projects p ON p.id = l.project_id
     WHERE l.token_hash = ? AND l.revoked_at IS NULL AND p.organization_id IS NULL`,
  ).get(sha256Hex(routeParam(req, "token")))) as {
    project_id: string; user_id: string; expires_at: number; name: string; project_type: string;
     design_data: string | null; width_mm: number; depth_mm: number; revision: number; created_at: number; updated_at: number; photo_file_id: string | null;
  } | undefined;
  if (!row || row.expires_at <= now()) {
    res.status(404).json({ error: "Share link is invalid or expired" });
    return;
  }
  let design: unknown = null;
  try {
    if (row.design_data) design = JSON.parse(decryptForUser(row.design_data, row.user_id));
  } catch {
    res.status(422).json({ error: "Shared design data is unreadable" });
    return;
  }
  res.json({ id: row.project_id, name: row.name, projectType: row.project_type, widthMm: row.width_mm, depthMm: row.depth_mm, design, readOnly: true, expiresAt: row.expires_at, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, hasPhoto: Boolean(row.photo_file_id) });
}));

export default router;

