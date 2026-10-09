/*
 * Google Antigravity OAuth adapted from oh-my-pi (MIT License).
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 * https://github.com/can1357/oh-my-pi
 *
 * 公开桌面客户端标识不入库：GitHub 推送保护会把它当成密钥。
 * 登录前设置 LINGUAGACHA_ANTIGRAVITY_CLIENT_ID 与 LINGUAGACHA_ANTIGRAVITY_CLIENT_SECRET。
 * 该登录违反 Antigravity 服务条款，有封号风险，仅供个人使用。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { AppError } from "../../shared/error";
import { is_json_record } from "../../domain/json";
import { create_provider_error, read_provider_response_error } from "../network/provider-error";
import { discover_antigravity_project } from "../llm/antigravity-cloud-code";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CALLBACK_PATH = "/oauth-callback";
const CALLBACK_PORT = 51121;
const TOKEN_TIMEOUT_MS = 15_000;
const AUTH_RANDOM_BYTES = 32;
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_refresh_token",
  "token_expired",
]);
const CLIENT_ID_ENV = "LINGUAGACHA_ANTIGRAVITY_CLIENT_ID";
const CLIENT_SECRET_ENV = "LINGUAGACHA_ANTIGRAVITY_CLIENT_SECRET";

/** 凭据携带项目 ID；刷新保持 `session_id` 与项目，供在途翻译继续使用。 */
export interface AntigravityCredential extends OAuthCredential {
  clientId: string;
  email: string;
  project_id: string;
  session_id: string;
}

/** 浏览器授权完成后立刻开通 Cloud Code 项目，失败则不保存半成品凭据。 */
export async function start_antigravity_login(options: {
  host_id: string;
  signal: AbortSignal;
  port?: number;
}): Promise<{ url: string; completion: Promise<AntigravityCredential> }> {
  const client = read_oauth_client();
  const { signal } = options;
  signal.throwIfAborted();
  const state = randomBytes(AUTH_RANDOM_BYTES).toString("base64url");
  const verifier = randomBytes(AUTH_RANDOM_BYTES).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = Promise.withResolvers<{ code: string }>();
  void callback.promise.catch(() => undefined);
  let accepted = false;
  const server = createServer((request, response) => {
    const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
    if (
      accepted ||
      url === null ||
      url.pathname !== CALLBACK_PATH ||
      url.searchParams.get("state") !== state
    ) {
      response.writeHead(400).end("Invalid authorization callback.");
      return;
    }
    accepted = true;
    const error = url.searchParams.get("error");
    if (error === "access_denied") {
      response.writeHead(200).end("Sign-in cancelled. You can close this window.");
      callback.reject(new AppError("runtime.cancelled"));
      return;
    }
    const code = url.searchParams.get("code");
    if (error || !code) {
      response.writeHead(400).end("Authorization failed. Return to LinguaGacha.");
      callback.reject(
        auth_error(
          url.searchParams.get("error_description") ?? error ?? "Invalid authorization callback.",
        ),
      );
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Return to LinguaGacha to view the sign-in result.");
    callback.resolve({ code });
  });
  const cancel = (): void => {
    callback.reject(new AppError("runtime.cancelled"));
  };
  signal.addEventListener("abort", cancel, { once: true });
  const port = options.port ?? CALLBACK_PORT;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE")
          reject(auth_error(`The Antigravity sign-in port ${port} is already in use.`));
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve();
      });
    });
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", cancel);
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string")
    throw auth_error("Unable to start the sign-in callback.");
  const redirect_uri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  }).toString();
  const completion = (async (): Promise<AntigravityCredential> => {
    try {
      const { code } = await callback.promise;
      const data = await request_token(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          client_secret: client.client_secret,
          code,
          code_verifier: verifier,
          redirect_uri,
        }),
        signal,
        null,
      );
      const email = await read_email(data.access, signal);
      const project_id = await discover_antigravity_project(data.access, signal);
      return {
        type: "oauth",
        ...data,
        clientId: client.client_id,
        email,
        project_id,
        session_id: randomUUID(),
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      server.close();
      server.closeAllConnections();
    }
  })();
  return { url: url.toString(), completion };
}

/** 刷新保持项目与会话身份。Google 不一定返回新的 refresh token。 */
export async function refresh_antigravity_credential(
  credential: AntigravityCredential,
  signal: AbortSignal,
): Promise<AntigravityCredential> {
  const client = read_oauth_client();
  const data = await request_token(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: credential.refresh,
    }),
    signal,
    credential.refresh,
  );
  return { ...credential, ...data, clientId: client.client_id };
}

/** 本地账户已经清除后再撤销远端 refresh token。 */
export async function revoke_antigravity_session(
  credential: AntigravityCredential,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "error",
    signal,
    body: new URLSearchParams({ token: credential.refresh }),
  });
  if (!response.ok) throw await read_provider_response_error(response);
}

async function request_token(
  body: URLSearchParams,
  signal: AbortSignal,
  previous_refresh: string | null,
): Promise<Pick<AntigravityCredential, "access" | "refresh" | "expires">> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    const error = await read_provider_response_error(response, {
      retryable: response.status >= 500 || response.status === 429,
    });
    error.diagnostic_context["auth_invalid"] =
      body.get("grant_type") === "refresh_token" &&
      TERMINAL_REFRESH_ERRORS.has(String(error.diagnostic_context["provider_code"]));
    throw error;
  }
  const data: unknown = await response.json();
  if (!is_json_record(data)) throw auth_error("Invalid Antigravity token response.");
  return token_fields(data, previous_refresh);
}

function token_fields(
  data: Record<string, unknown>,
  previous_refresh: string | null,
): Pick<AntigravityCredential, "access" | "refresh" | "expires"> {
  const refresh =
    typeof data["refresh_token"] === "string" && data["refresh_token"] !== ""
      ? data["refresh_token"]
      : previous_refresh;
  if (
    typeof data["access_token"] !== "string" ||
    data["access_token"] === "" ||
    refresh === null ||
    refresh === "" ||
    typeof data["expires_in"] !== "number" ||
    !Number.isFinite(data["expires_in"]) ||
    data["expires_in"] <= 0
  )
    throw auth_error("Invalid Antigravity token response.");
  return {
    access: data["access_token"],
    refresh,
    expires: Date.now() + data["expires_in"] * 1_000,
  };
}

async function read_email(access_token: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
  });
  if (!response.ok) throw await read_provider_response_error(response);
  const data: unknown = await response.json();
  if (!is_json_record(data) || typeof data["email"] !== "string" || data["email"] === "")
    throw auth_error("Antigravity did not return an account email.");
  return data["email"];
}

/** 只接受当前进程环境变量，避免把公开客户端标识写进仓库或凭据以外的配置。 */
function read_oauth_client(): { client_id: string; client_secret: string } {
  const client_id = process.env[CLIENT_ID_ENV]?.trim() ?? "";
  const client_secret = process.env[CLIENT_SECRET_ENV]?.trim() ?? "";
  if (client_id === "" || client_secret === "")
    throw auth_error(
      `Set ${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV} to the public Antigravity desktop OAuth client before signing in.`,
    );
  return { client_id, client_secret };
}

function auth_error(reason: string): AppError {
  return create_provider_error(reason, undefined, { retryable: false });
}
