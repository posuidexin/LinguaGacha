import type { OAuthProvider } from "../../domain/model";

/** 请求层只拿本轮 token；Antigravity 另外携带已开通的项目 ID。 */
export type ResolvedOAuthCredential = {
  apiKey: string;
  project_id?: string;
};

/** 翻译、模型列表和 Agent 共用的账户解析端口，按提供方选择连接。 */
export interface ModelOAuthPort {
  bind(provider: OAuthProvider): string;
  resolve(
    provider: OAuthProvider,
    session_id: string,
    signal?: AbortSignal,
  ): Promise<ResolvedOAuthCredential>;
}
