import axios, { type AxiosRequestConfig } from "axios";
import type { AuthType, HttpMethod } from "./types.js";

/**
 * Generic HTTP client for any live-rate API.
 *
 * Everything (URL, method, auth style, headers, body) comes from configuration.
 * No provider is referenced anywhere in this file.
 */

export interface HttpClientConfig {
  url: string;
  method: HttpMethod;
  apiKey: string;
  authType: AuthType;
  /** Query parameter or header name carrying the key. */
  keyName: string;
  timeoutMs: number;
  /** Extra static headers. */
  headers?: Record<string, string>;
  /** Extra static query parameters. */
  query?: Record<string, string>;
  /** JSON body for POST requests. */
  body?: unknown;
}

export class HttpError extends Error {}

export async function fetchJson(cfg: HttpClientConfig): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(cfg.headers ?? {}),
  };

  const params: Record<string, string> = { ...(cfg.query ?? {}) };

  if (cfg.apiKey) {
    if (cfg.authType === "query") params[cfg.keyName] = cfg.apiKey;
    if (cfg.authType === "header") headers[cfg.keyName] = cfg.apiKey;
    if (cfg.authType === "bearer") headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  const request: AxiosRequestConfig = {
    url: cfg.url,
    method: cfg.method,
    timeout: cfg.timeoutMs,
    headers,
    params,
    responseType: "json",
    validateStatus: () => true,
  };

  if (cfg.method === "POST") request.data = cfg.body ?? {};

  const res = await axios.request(request);

  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(`HTTP ${res.status}`);
  }

  let body: unknown = res.data;

  // Some APIs return JSON with a text/plain content type.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError("response body is not valid JSON");
    }
  }

  if (body === null || typeof body !== "object") {
    throw new HttpError("response body is not a JSON object");
  }

  return body;
}
