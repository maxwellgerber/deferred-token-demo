import { DemoSession, Env as SessionEnv, ISSUER } from "./session";
import { corsPreflight, jsonResponse } from "./dtr";

export { DemoSession };

export interface Env extends SessionEnv {
  SESSION_DO: DurableObjectNamespace<DemoSession>;
}

const DISCOVERY_METADATA = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/token`,
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer", "urn:ietf:params:oauth:grant-type:deferred"],
  deferred_token_response_supported: true,
  authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse(200, DISCOVERY_METADATA);
    }

    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      return jsonResponse(400, { error: "invalid_request", error_description: "missing ?session= identifier" });
    }

    const id = env.SESSION_DO.idFromName(sessionId);
    const stub = env.SESSION_DO.get(id);
    return stub.fetch(request);
  },
};
