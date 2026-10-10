import type { AppPathService } from "../app/app-path-service";
import type { JsonRecord } from "../../domain/json";
import type { RuntimeOperationGate } from "../runtime-operation-gate";
import {
  refresh_chatgpt_credential,
  revoke_chatgpt_session,
  start_chatgpt_login,
  type ChatGPTCredential,
} from "./chatgpt-oauth";
import type { OAuthAccountProtocol } from "./oauth-account-service";
import { OAuthAccountService } from "./oauth-account-service";

const CHATGPT_PROTOCOL: OAuthAccountProtocol<ChatGPTCredential> = {
  file_name: "chatgpt.json",
  credential_label: "ChatGPT",
  timeout_message: "ChatGPT sign-in timed out.",
  start_login(options) {
    return start_chatgpt_login(options);
  },
  refresh(credential, signal) {
    return refresh_chatgpt_credential(credential, signal);
  },
  revoke(credential, signal) {
    return revoke_chatgpt_session(credential, signal);
  },
  present(credential) {
    return { apiKey: credential.access };
  },
};

/** ChatGPT 账户是通用 OAuth 账户服务的一个提供方。 */
export class ChatGPTAuthService extends OAuthAccountService<ChatGPTCredential> {
  /** 装配 ChatGPT 协议与 `auth/chatgpt.json`。 */
  public constructor(
    paths: AppPathService,
    gate: RuntimeOperationGate,
    publish: (topic: string, payload: JsonRecord) => void,
  ) {
    super(paths, gate, publish, CHATGPT_PROTOCOL);
  }
}
