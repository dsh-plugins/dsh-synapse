import { getHermesConfig } from '@/features/hermes/config';
import { ApprovalChoice, HermesEventCallbacks, MessageContentPart } from '@/features/hermes/types';

/** 提交运行参数 */
interface SubmitRunParams {
  userMessage: string | MessageContentPart[];
  sessionId?: string;
  systemPrompt?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

/**
 * Hermes API 客户端（移植自 qq-hermes-bridge src/hermes.ts，MIT 协议，原作者 Amorter）。
 * 负责异步提交任务、监听 SSE 事件流、审批管理和任务停止。
 * 配置每次调用时读取（ConfigStore 热重载生效）。
 */
export class HermesClient {
  private get baseUrl(): string {
    return getHermesConfig().apiUrl;
  }

  /**
   * 提交异步运行任务。
   * @returns 包含 runId 和 status 的结果
   */
  public async submitRun({ userMessage, sessionId, systemPrompt, conversationHistory }: SubmitRunParams): Promise<{
    runId: string;
    status: string;
  }> {
    // 多模态消息：input 需传消息数组，最后一条携带图片内容段；纯文本保持原样
    const body: Record<string, unknown> = {
      input: Array.isArray(userMessage) ? [{ role: 'user', content: userMessage }] : userMessage
    };
    if (systemPrompt) body.instructions = systemPrompt;
    if (sessionId) body.session_id = sessionId;
    if (conversationHistory?.length) body.conversation_history = conversationHistory;

    const resp = await fetch(`${this.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`submitRun 失败 ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as Record<string, string>;
    return {
      runId: data.run_id || data.id || '',
      status: data.status || ''
    };
  }

  /**
   * 连接 SSE 事件流，监听运行过程中的各类事件。
   * @param runId 运行 ID
   * @param callbacks 事件回调映射
   * @returns 包含 abort 方法的控制器
   */
  public streamEvents(runId: string, callbacks: HermesEventCallbacks): { abort(): void } {
    const url = `${this.baseUrl}/v1/runs/${runId}/events`;
    const headers = this.headers({ Accept: 'text/event-stream' });

    let aborted = false;
    const controller = new AbortController();

    const doConnect = async () => {
      try {
        const resp = await fetch(url, { headers, signal: controller.signal });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          callbacks._error?.(new Error(`SSE ${resp.status}: ${text.slice(0, 200)}`));
          return;
        }

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            // SSE event 行：记录当前事件类型
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim();
              if (!jsonStr) continue;
              try {
                const data = JSON.parse(jsonStr) as { event?: string } & Record<string, unknown>;
                // 优先用 SSE event 行的类型，其次用 data.event
                const eventType =
                  currentEvent || (data.event as string) || (data as Record<string, unknown>).type as string || 'unknown';

                if (eventType) {
                  const handler = (callbacks as Record<string, ((ev: unknown) => void) | undefined>)[eventType];
                  if (handler) {
                    handler(data);
                  } else {
                    callbacks._any?.(data as never);
                  }
                  // run.completed / run.failed 也触发 _end
                  if (eventType === 'run.completed' || eventType === 'run.failed') {
                    callbacks._end?.();
                  }
                }

                currentEvent = ''; // 重置，等待下一个事件
              } catch {
                // 非 JSON 的 SSE 数据（心跳注释）
              }
            } else if (line.startsWith(': stream closed')) {
              callbacks._end?.();
              return;
            }
          }
        }
        callbacks._end?.();
      } catch (err) {
        if (!aborted) callbacks._error?.(err as Error);
      }
    };

    void doConnect();

    return {
      /** 中止 SSE 连接 */
      abort() {
        aborted = true;
        controller.abort();
      }
    };
  }

  /**
   * 批准或拒绝待审批命令。
   * @param runId 运行 ID
   * @param choice 审批选择：once | deny | always | session
   */
  public async resolveApproval(runId: string, choice: ApprovalChoice): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}/v1/runs/${runId}/approval`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ choice })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`审批处理失败 ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }

  /**
   * 停止正在运行的 Agent 任务。
   * @param runId 运行 ID
   * @returns 是否成功停止
   */
  public async stopRun(runId: string): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/v1/runs/${runId}/stop`, {
      method: 'POST',
      headers: this.headers()
    });
    return resp.ok;
  }

  /** 构建请求头 */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    const apiKey = getHermesConfig().apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return headers;
  }
}
