// Shared server helpers for the Vercel functions (files starting with "_"
// are not routes).
import { createSign } from "node:crypto";

/** ?app= → which Google Sheet that page may touch. */
export const APPS = {
  stock: { spreadsheetId: "DEMO_WAREHOUSE_SHEET_ID", label: "倉庫", title: "倉庫存貨" },
  groupbuy: { spreadsheetId: "DEMO_GROUPBUY_SHEET_ID", label: "團購", title: "團購記錄" },
};

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// --- Google service-account auth (no SDK: a signed JWT → OAuth token) -------

function serviceAccount() {
  let email = process.env.GOOGLE_CLIENT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const sa = JSON.parse(json);
      email = sa.client_email;
      key = sa.private_key;
    } catch {
      throw new HttpError(500, "not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON 唔係有效嘅 JSON。");
    }
  }
  if (!email || !key) throw new HttpError(500, "not_configured", "未設定 Google service account。");
  return { email, key: key.replace(/\\n/g, "\n") };
}

/** The service account's private key (PEM), or "" if not configured. */
export function serviceAccountKey() {
  try {
    return serviceAccount().key;
  } catch {
    return "";
  }
}

export function serviceAccountEmail() {
  try {
    return serviceAccount().email;
  } catch {
    return "";
  }
}

let cached = null; // { token, exp }

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const { email, key } = serviceAccount();
  const unsigned =
    b64url({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64url({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  let sig;
  try {
    sig = createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
  } catch {
    throw new HttpError(500, "not_configured", "Google service account 嘅 private key 用唔到。");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new HttpError(502, "upstream_error", `Google 登入失敗（${res.status}）。`);
  }
  cached = { token: body.access_token, exp: now + (body.expires_in ?? 3600) };
  return cached.token;
}

/** Calls the Google Sheets API; maps its errors to {status, code, message}. */
export async function sheetsApi(method, path, body) {
  const token = await accessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const msg = json?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 403 || res.status === 404) {
    const who = serviceAccountEmail();
    throw new HttpError(
      403,
      "no_access",
      `Service account 冇權限開呢個 Google Sheet — 請喺 Sheet 撳「共用」加 ${who || "service account 個 email"}（編輯者）。`,
    );
  }
  if (res.status === 400) throw new HttpError(400, "tool_error", msg);
  if (res.status === 429) throw new HttpError(429, "rate_limited", msg);
  throw new HttpError(502, "upstream_error", msg);
}

export function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}
