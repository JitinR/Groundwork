import { hkdfSync } from "node:crypto";
import { decryptAesGcm, encryptAesGcm, type EncryptedPayload } from "./crypto.js";

const PREFIX = "groundwork-render:v1:";
export type RenderInputField = "prompt" | "negative_prompt" | "parameters_json" | "style_preset";
export interface RenderPayloadContext { projectId: string; jobId: string; field: RenderInputField }
export interface OpenedRenderPayload { plaintext: string; needsRewrite: boolean; metadata?: string }
type RenderEnvelope = EncryptedPayload & { metadata?: EncryptedPayload };
export function createRenderPayloadCodec(masterKey: Buffer, previousMasterKey?: Buffer | null) {
  const derive = (master: Buffer) => Buffer.from(hkdfSync("sha256", master, Buffer.from("groundwork-render-job"), Buffer.from("render-input-v1"), 32));
  const current = derive(masterKey), previous = previousMasterKey ? derive(previousMasterKey) : null;
  const aad = (context: RenderPayloadContext, metadata = false) =>
    JSON.stringify(["groundwork-render", 1, context.projectId, context.jobId, context.field, ...(metadata ? ["metadata"] : [])]);
  const seal = (plaintext: string, context: RenderPayloadContext, metadata?: string) => {
    const payload: RenderEnvelope = encryptAesGcm(plaintext, current, aad(context));
    if (metadata !== undefined) payload.metadata = encryptAesGcm(metadata, current, aad(context, true));
    return PREFIX + JSON.stringify(payload);
  };
  const open = (stored: string, context: RenderPayloadContext): OpenedRenderPayload => {
    if (stored.startsWith("groundwork-render:") && !stored.startsWith(PREFIX)) throw new Error("Unsupported stored render input version");
    if (!stored.startsWith(PREFIX)) return { plaintext: stored, needsRewrite: true };
    try {
      const payload = JSON.parse(stored.slice(PREFIX.length)) as RenderEnvelope;
      if (!payload || typeof payload.iv !== "string" || typeof payload.tag !== "string" || typeof payload.data !== "string") throw new Error("Invalid encrypted render input");
      const decrypt = (key: Buffer, needsRewrite: boolean): OpenedRenderPayload => {
        const result: OpenedRenderPayload = { plaintext: decryptAesGcm(payload, key, aad(context)), needsRewrite };
        if (payload.metadata !== undefined) result.metadata = decryptAesGcm(payload.metadata, key, aad(context, true));
        return result;
      };
      try { return decrypt(current, false); }
      catch { if (!previous) throw new Error("Render input cannot be decrypted"); return decrypt(previous, true); }
    } catch { throw new Error("Stored render input could not be authenticated"); }
  };
  return { seal, open };
}
