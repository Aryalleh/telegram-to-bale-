/**
 * Encryption for secrets entered from the admin dashboard.
 *
 * Tokens managed via the web UI are stored in D1 *encrypted at rest* with
 * AES-GCM. The key is derived from `ADMIN_API_SECRET` (a Cloudflare secret set
 * once via the CLI) so that only one root secret must be provisioned outside
 * the dashboard; everything else can be entered and rotated from the web.
 *
 * Note: rotating ADMIN_API_SECRET invalidates previously stored ciphertexts —
 * re-enter the tokens from the dashboard after changing it.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(adminSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(adminSecret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt plaintext -> base64(iv[12] || ciphertext). */
export async function encryptValue(adminSecret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(adminSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return bytesToB64(packed);
}

/** Decrypt a value produced by encryptValue. Returns null if it can't be read. */
export async function decryptValue(adminSecret: string, packedB64: string): Promise<string | null> {
  try {
    const key = await deriveKey(adminSecret);
    const packed = b64ToBytes(packedB64);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}
