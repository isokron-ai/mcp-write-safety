// The MCP layer's HTTP client for the tracker backend. Every backend call goes
// through here, so a loopback gate placed in front of the backend sees all of
// them (that is how a tester forces an interleaving).

import { attributionHeaders } from "../attribution.js";

export interface ApiResponse<T = any> {
  status: number;
  ok: boolean;
  body: T;
  /** The version from the ETag header, when the backend sent one. */
  version?: number;
  /** True when the backend answered a repeated keyed or conditional write from its record. */
  replayed: boolean;
  /** The request as sent, kept for error reporting. Never put it in a tool result as is. */
  request: { method: string; url: string; headers: Record<string, string> };
}

export interface RequestOptions {
  body?: unknown;
  ifMatch?: number | "*";
  idempotencyKey?: string;
  query?: Record<string, string | undefined>;
}

export class TrackerApi {
  /** stampAttribution: put the current call's run and operation tags on every request (design rule 3). */
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly stampAttribution = false) {}

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.ifMatch !== undefined) headers["if-match"] = options.ifMatch === "*" ? "*" : `"${options.ifMatch}"`;
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    if (this.stampAttribution) Object.assign(headers, attributionHeaders());
    const request = { method, url: url.toString(), headers };
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      text = await response.text();
    } catch {
      // No HTTP answer at all (connection refused or reset). Status 0: the outcome is unknown.
      return { status: 0, ok: false, body: { error: "connection_failed" } as T, replayed: false, request };
    }
    const tag = response.headers.get("etag");
    return {
      status: response.status,
      ok: response.ok,
      body: (text ? JSON.parse(text) : undefined) as T,
      version: tag ? Number(tag.replace(/"/g, "")) : undefined,
      replayed: response.headers.get("idempotent-replayed") === "true",
      request,
    };
  }
}
