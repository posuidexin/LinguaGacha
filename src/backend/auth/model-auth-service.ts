import { randomUUID } from "node:crypto";
import type { OAuthProvider } from "../../domain/model";
import type { JsonRecord } from "../../domain/json";
import { AppError } from "../../shared/error";
import {
  MODEL_AUTH_CHANGED_EVENT_TOPIC,
  type ModelAuthLoginResponse,
  type ModelAuthSnapshot,
  type OAuthAccountSnapshot,
  type OAuthProviderState,
} from "../../shared/model-auth";
import type { AppPathService } from "../app/app-path-service";
import type { RuntimeOperationGate } from "../runtime-operation-gate";
import { AntigravityAuthService } from "./antigravity-auth-service";
import { ChatGPTAuthService } from "./chatgpt-auth-service";
import type { ModelOAuthPort, ResolvedOAuthCredential } from "./model-oauth-port";

/**
 * GUI、CLI 和翻译共用的账户入口。各提供方仍拥有自己的文件与登录尝试，
 * 对外只发布一份带统一修订号的快照，避免后到的 ChatGPT 事件覆盖 Antigravity。
 */
export class ModelAuthService implements ModelOAuthPort {
  public readonly chatgpt: ChatGPTAuthService;
  public readonly antigravity: AntigravityAuthService;
  private readonly instance_id = randomUUID();
  private revision = 0;
  private seen_chatgpt = -1;
  private seen_antigravity = -1;

  /** 两个账户服务的事件都收成同一份合并快照。 */
  public constructor(
    paths: AppPathService,
    gate: RuntimeOperationGate,
    private readonly publish: (topic: string, payload: JsonRecord) => void,
  ) {
    const publish_combined = (): void => {
      this.publish(MODEL_AUTH_CHANGED_EVENT_TOPIC, { snapshot: this.snapshot() });
    };
    this.chatgpt = new ChatGPTAuthService(paths, gate, publish_combined);
    this.antigravity = new AntigravityAuthService(paths, gate, publish_combined);
  }

  /** 任一提供方修订变化时推进合并修订；重复读取不改变修订。 */
  public snapshot(): ModelAuthSnapshot {
    const chatgpt = this.chatgpt.snapshot();
    const antigravity = this.antigravity.snapshot();
    if (chatgpt.revision !== this.seen_chatgpt || antigravity.revision !== this.seen_antigravity) {
      this.seen_chatgpt = chatgpt.revision;
      this.seen_antigravity = antigravity.revision;
      this.revision += 1;
    }
    return {
      instance_id: this.instance_id,
      revision: this.revision,
      providers: {
        chatgpt: provider_state(chatgpt),
        "google-antigravity": provider_state(antigravity),
      },
    };
  }

  /** 省略提供方时仍登录 ChatGPT，以保持原 `/api/models/auth/login` 的行为。 */
  public async login(provider: unknown): Promise<ModelAuthLoginResponse> {
    const response = await this.account(read_requested_provider(provider)).login();
    return { id: response.id, url: response.url, snapshot: this.snapshot() };
  }

  /** 取消只作用于指定提供方；未写提供方时按授权 ID 查找仍在进行的尝试。 */
  public async cancel_login(
    provider: unknown,
    id: unknown,
  ): Promise<{ snapshot: ModelAuthSnapshot }> {
    if (provider === undefined) {
      await this.chatgpt.cancel_login(id);
      await this.antigravity.cancel_login(id);
    } else await this.account(read_requested_provider(provider)).cancel_login(id);
    return { snapshot: this.snapshot() };
  }

  /** 退出只清除一个提供方的本地凭据。 */
  public async logout(provider: unknown): Promise<{ snapshot: ModelAuthSnapshot }> {
    await this.account(read_requested_provider(provider)).logout();
    return { snapshot: this.snapshot() };
  }

  /** 任务启动时绑定该提供方当前会话。 */
  public bind(provider: OAuthProvider): string {
    return this.account(provider).bind();
  }

  /** 每次请求解析该提供方的 token；Antigravity 同时返回项目 ID。 */
  public resolve(
    provider: OAuthProvider,
    session_id: string,
    signal?: AbortSignal,
  ): Promise<ResolvedOAuthCredential> {
    return this.account(provider).resolve(session_id, signal);
  }

  /** 两个账户的登录与刷新都结束后再关闭。 */
  public async dispose(): Promise<void> {
    await this.chatgpt.dispose();
    await this.antigravity.dispose();
  }

  private account(provider: OAuthProvider): ChatGPTAuthService | AntigravityAuthService {
    return provider === "google-antigravity" ? this.antigravity : this.chatgpt;
  }
}

function provider_state(snapshot: OAuthAccountSnapshot): OAuthProviderState {
  return { connected: snapshot.connected, login: snapshot.login };
}

/** 未传提供方保持 ChatGPT。未知值直接拒绝，避免把 Antigravity 登录写进错误账户。 */
export function read_requested_provider(provider: unknown): OAuthProvider {
  if (provider === undefined || provider === "chatgpt") return "chatgpt";
  if (provider === "google-antigravity") return "google-antigravity";
  throw new AppError("request.validation_failed");
}
