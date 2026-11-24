import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
const scryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function randomId(): string {
  return randomBytes(16).toString("hex");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, scryptOptions).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hashHex: string): boolean {
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, scryptOptions);
  return timingSafeEqual(actual, expected);
}

export async function verifyPasswordAsync(password: string, salt: string, hashHex: string): Promise<boolean> {
  const expected = Buffer.from(hashHex, "hex");
  if (!expected.length) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, scryptOptions, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return timingSafeEqual(actual, expected);
}

export function deriveVaultKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from("groundwork-vault"), Buffer.from("vault-key-ctx"), 32));
}

export interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

export function encryptAesGcm(plaintext: string, key: Buffer, aad?: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), data: encrypted.toString("base64") };
}

export function decryptAesGcm(payload: EncryptedPayload, key: Buffer, aad?: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
