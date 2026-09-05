// Minimal HS256 JWT sign/verify for the demo's stand-in "identity assertion" minting.
// Not a general-purpose JWT library: no alg negotiation, no key rotation. The real
// protocol this demo teaches (DTR) starts at the token request below, not here.

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, secret: string): Promise<string> {
  const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export class JwtValidationError extends Error {}

export async function verifyJwt(token: string, secret: string): Promise<DecodedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtValidationError("malformed JWT");
  const [encodedHeader, encodedClaims, encodedSig] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlDecode(encodedSig),
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) throw new JwtValidationError("signature verification failed");
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(encodedHeader)));
  const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(encodedClaims)));
  if (typeof claims.exp === "number" && claims.exp < Date.now() / 1000) {
    throw new JwtValidationError("assertion expired");
  }
  return { header, claims };
}
