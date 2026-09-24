import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt parameters (OWASP minimum: N=2^17, r=8, p=1). Encoded into the hash so they can be raised later.
// PASSWORD_HASH_LOG2_N lowers the cost for tests only.
const N = 1 << Number(process.env.PASSWORD_HASH_LOG2_N ?? 17);
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A precomputed hash used to equalise timing when a login email does not exist. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(len: number): string {
  // Rejection sampling keeps the distribution uniform.
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += BASE62[b % 62];
    }
  }
  return out;
}

export const API_KEY_PREFIX = "wsk_";

/**
 * API key format: wsk_<8 char id>_<40 char secret>.
 * The "wsk_<id>" part is stored in clear as a lookup prefix; the full key is stored only as SHA-256.
 * (A fast hash is appropriate here: the secret has ~238 bits of entropy, so brute force is infeasible.)
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = `${API_KEY_PREFIX}${base62(8)}`;
  const key = `${prefix}_${base62(40)}`;
  return { key, prefix, hash: sha256Hex(key) };
}

export function parseApiKey(key: string): { prefix: string } | null {
  const m = /^(wsk_[0-9A-Za-z]{8})_[0-9A-Za-z]{40}$/.exec(key);
  return m ? { prefix: m[1]! } : null;
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
