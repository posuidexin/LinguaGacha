import type { OAuthProvider } from "../domain/model";
import type { ApiErrorPayload } from "./error";

/** 最近一次授权的结果留在运行态，重连快照也能结束对应模态窗。 */
export type OAuthLoginSnapshot = Readonly<
  | { id: string; status: "pending" | "succeeded" | "cancelled" }
  | { id: string; status: "failed"; error: Readonly<ApiErrorPayload> }
>;

/** 单个提供方的两态连接快照。修订由该提供方的账户服务维护。 */
export type OAuthAccountSnapshot = Readonly<{
  instance_id: string;
  revision: number;
  connected: boolean;
  login: OAuthLoginSnapshot | null;
}>;

export type OAuthLoginResponse = Readonly<{
  id: string;
  url: string;
  snapshot: OAuthAccountSnapshot;
}>;

/** 页面只消费合并后的快照；各提供方的连接与登录互不覆盖。 */
export type OAuthProviderState = Readonly<{
  connected: boolean;
  login: OAuthLoginSnapshot | null;
}>;

export type ModelAuthSnapshot = Readonly<{
  instance_id: string;
  revision: number;
  providers: Readonly<Record<OAuthProvider, OAuthProviderState>>;
}>;

export type ModelAuthLoginResponse = Readonly<{
  id: string;
  url: string;
  snapshot: ModelAuthSnapshot;
}>;

/** ChatGPT 账户服务沿用合并前的单账户形状。 */
export type ChatGPTLoginSnapshot = OAuthLoginSnapshot;
export type ChatGPTAuthSnapshot = OAuthAccountSnapshot;
export type ChatGPTLoginResponse = OAuthLoginResponse;

export const MODEL_AUTH_CHANGED_EVENT_TOPIC = "model.auth_changed";
