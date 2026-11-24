/**
 * HTTP 请求与错误类型：REST 与 GraphQL 共用。
 */

import { RED, YELLOW, intOf, printColor } from "./format.js";

export class ApiError extends Error {
  constructor(kind, message = "") {
    super(message);
    this.name = "ApiError";
    this.kind = kind; // "rate_limit" | "failure"
    this.message = message;
  }
}

export async function githubApiRequest(app, url, token = null) {
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "generate-stats",
  };
  const auth = token === null ? app.token : token;
  if (auth) {
    headers.Authorization = `token ${auth}`;
  }

  let status;
  let remaining;
  let body;
  try {
    const response = await fetch(url, {
      headers,
      method: "GET",
      signal: AbortSignal.timeout(60_000),
    });
    status = response.status;
    remaining = response.headers.get("x-ratelimit-remaining");
    body = await response.text();
  } catch {
    printColor("❌ 网络请求失败", RED);
    throw new ApiError("failure");
  }

  if (status >= 200 && status < 400) {
    if (remaining !== null && remaining !== undefined) {
      const left = Number.parseInt(remaining, 10);
      if (
        Number.isFinite(left) &&
        left < intOf(app.api.rate_limit_warn_threshold, 50)
      ) {
        printColor(`⚠️  API 配额剩余: ${remaining}`, YELLOW);
      }
    }
    return body;
  }

  if (status === 403 || status === 429) {
    const left = remaining === null ? -1 : Number.parseInt(remaining, 10);
    if (left === 0 || Number.isNaN(left) || status === 429) {
      let message = `HTTP ${status}`;
      try {
        message = JSON.parse(body).message || message;
      } catch {
        // 保持 HTTP 状态码作为提示
      }
      throw new ApiError("rate_limit", `GitHub API 配额耗尽: ${message}`);
    }
  }

  let detail = "";
  try {
    detail = JSON.parse(body).message ?? "";
  } catch {
    detail = "";
  }
  throw new ApiError(
    "failure",
    `HTTP ${status}` + (detail ? `: ${detail}` : ""),
  );
}

/** 请求并解析 JSON；HTTP 失败抛 ApiError，响应不是 JSON 时返回 null。 */
export async function apiJson(app, url, token = null) {
  const body = await githubApiRequest(app, url, token);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * 发一条 GraphQL 查询，返回响应里的 `data`。
 *
 * GraphQL 出错也回 200，错误藏在 `body.errors` 里，只看状态码会把失败当成功；
 * 配额耗尽则沿用 REST 那套判断（403/429 且剩余额度为 0）。
 */
export async function graphqlJson(app, query, variables = {}, token = null) {
  const auth = token === null ? app.token : token;
  if (!auth) {
    throw new ApiError("failure", "缺少令牌，无法查询 GraphQL");
  }

  let response;
  let raw;
  try {
    response = await fetch(`${app.api.github_api_base}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "generate-stats",
        Authorization: `bearer ${auth}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    raw = await response.text();
  } catch {
    printColor("❌ 网络请求失败", RED);
    throw new ApiError("failure");
  }

  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  if (response.status === 403 || response.status === 429) {
    const left = Number.parseInt(
      response.headers.get("x-ratelimit-remaining") ?? "",
      10,
    );
    if (!Number.isFinite(left) || left === 0 || response.status === 429) {
      throw new ApiError("rate_limit", "GitHub GraphQL 配额耗尽");
    }
  }
  if (!response.ok) {
    const detail = body?.message ? `: ${body.message}` : "";
    throw new ApiError("failure", `HTTP ${response.status}${detail}`);
  }
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw new ApiError(
      "failure",
      String(body.errors[0]?.message || "GraphQL 查询失败"),
    );
  }
  return body?.data ?? null;
}
