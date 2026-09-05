// Shared response helpers for the Deferred Token Response protocol.
// Kept separate from any one scenario's DemoSession so later scenarios reuse it.

export type DtrErrorCode =
  | "authorization_pending"
  | "interaction_required"
  | "interaction_pending" // PR #68 against the draft: approved, not yet merged.
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "invalid_grant"
  | "invalid_request"
  | "unsupported_grant_type";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export interface DeferredResponseFields {
  deferral_code: string;
  expires_in: number;
  interval: number;
  interaction_uri?: string;
  error_description?: string;
}

export function deferredErrorResponse(error: DtrErrorCode, fields: Partial<DeferredResponseFields> & { error_description?: string }): Response {
  return jsonResponse(400, { error, ...fields });
}

export function tokenSuccessResponse(fields: Record<string, unknown>): Response {
  return jsonResponse(200, fields);
}

export function generateOpaqueId(bits = 160): string {
  const bytes = new Uint8Array(bits / 8);
  crypto.getRandomValues(bytes);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
