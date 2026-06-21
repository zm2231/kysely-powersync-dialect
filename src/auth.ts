import type { PowerSyncConfig, TokenResponse } from "./types.js";

export interface PowerSyncConfigValidationOptions {
  requireAuthUrl?: boolean;
  requireUploadUrl?: boolean;
}

export function validatePowerSyncConfig(
  config: PowerSyncConfig,
  options: PowerSyncConfigValidationOptions = {},
): void {
  const requireAuthUrl = options.requireAuthUrl ?? true;
  const requireUploadUrl = options.requireUploadUrl ?? true;
  validateHttpUrl("powersync_url", config.powersync_url);
  if (config.auth_url) {
    validateHttpUrl("auth_url", config.auth_url);
  } else if (requireAuthUrl) {
    throw new Error("PowerSync auth_url is required unless fetchCredentials is provided");
  }
  if (config.upload_url) {
    validateHttpUrl("upload_url", config.upload_url);
  } else if (requireUploadUrl) {
    throw new Error("PowerSync upload_url is required unless uploadTransaction is provided");
  }
  if (!config.user_id.trim()) {
    throw new Error("PowerSync user_id is required");
  }
  if (!config.db_path.trim()) {
    throw new Error("PowerSync db_path is required");
  }
  const hasCfId = Boolean(config.cf_access_client_id);
  const hasCfSecret = Boolean(config.cf_access_client_secret);
  if (hasCfId !== hasCfSecret) {
    throw new Error("PowerSync Cloudflare Access config requires both client id and client secret");
  }
}

export async function fetchPowerSyncToken(config: PowerSyncConfig): Promise<TokenResponse> {
  validatePowerSyncConfig(config, { requireAuthUrl: true, requireUploadUrl: false });
  const url = new URL(config.auth_url!);
  url.searchParams.set("user_id", config.user_id);
  const response = await fetch(url, { headers: cfHeaders(config) });
  if (!response.ok) {
    throw new Error(`PowerSync auth failed: ${response.status} ${response.statusText}`);
  }
  return parseTokenResponse(await response.json());
}

export function cfHeaders(config: PowerSyncConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.cf_access_client_id && config.cf_access_client_secret) {
    headers["CF-Access-Client-Id"] = config.cf_access_client_id;
    headers["CF-Access-Client-Secret"] = config.cf_access_client_secret;
  }
  return headers;
}

function validateHttpUrl(field: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`PowerSync ${field} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PowerSync ${field} must use http or https`);
  }
}

export function parseTokenResponse(payload: unknown): TokenResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("PowerSync auth response must be a JSON object");
  }
  const response = payload as Partial<TokenResponse>;
  if (typeof response.token !== "string" || response.token.trim().length === 0) {
    throw new Error("PowerSync auth response is missing token");
  }
  if (typeof response.expires_at !== "number" || !Number.isFinite(response.expires_at)) {
    throw new Error("PowerSync auth response is missing numeric expires_at");
  }
  return {
    token: response.token,
    expires_at: response.expires_at,
  };
}
