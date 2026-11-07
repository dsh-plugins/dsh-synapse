import type { ConfigSource, PluginPaths, ErrorSink, VoiceSender, VoiceReceipt } from "./types.js";
import { fork } from "node:child_process";
import { mkdir, cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { atomicWrite } from "./files.js";
import { featureFiles } from "./feature-config.js";
import { randomUUID } from "node:crypto";
import type { IdleActivation } from "./chat-activity.js";
import { abortable } from "./abort.js";
export class Bot {
  paths: PluginPaths;
  config: ConfigSource;
  gateway: import("./gateway.js").Gateway;
  onError: ErrorSink;
  state: string;
  stopping: boolean;
  child: import("node:child_process").ChildProcess;
  stderr: string;
  private activations = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private restarting?: Promise<void>;
  private voices = new Map<string, { resolve(receipt: VoiceReceipt): void; reject(error: Error): void }>();
  private groupChecks = new Map<string, { resolve(allowed: boolean): void; reject(error: Error): void }>();

  constructor(
    paths: PluginPaths,
    config: ConfigSource,
    gateway: import("./gateway.js").Gateway,
    onError: ErrorSink,
  ) {
    Object.assign(this, { paths, config, gateway, onError });
    this.state = "stopped";
    this.stopping = false;
  }
  async start() {
    const c = this.config();
    if (!c.enabled) return;
    const cwd = path.join(this.paths.data, "bot");
    await mkdir(path.join(cwd, "configs", "features"), { recursive: true });
    await cp(
      fileURLToPath(
        new URL("../../vendor/gugle-chat-bot/src", import.meta.url),
      ),
      path.join(cwd, "src"),
      { recursive: true },
    );
    const connection = c.connection;
    await atomicWrite(
      path.join(cwd, "configs", "bot-config.json"),
      JSON.stringify({
        userAgent: connection.userAgent,
        tokenParams: connection.tokenParams,
        httpUrl: connection.httpUrl,
        wsUrl: connection.wsUrl,
        httpToken: connection.httpToken,
        wsToken: connection.wsToken,
        chromePath: connection.chromePath,
        githubAllowedRepositories: c.github.repositories.map(row => row.repository),
        logLevel: connection.logLevel,
      }),
    );
    // Existing feature files contain live /github subscribe and admin changes.
    // Only replace a module when its dashboard configuration has changed.
    let previous = {};
    const marker = path.join(cwd, "applied-config.json");
    try {
      previous = JSON.parse(await readFile(marker, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const applied = {};
    for (const f of featureFiles(c)) {
      const serialized = JSON.stringify(f.value);
      applied[f.id] = serialized;
      const file = path.join(
        cwd,
        "configs",
        ...(f.id === "peak-valley-timer" ? [] : ["features"]),
        `${f.id}.json`,
      );
      let feature = f.value;
      if (previous[f.id] === serialized)
        try {
          feature = JSON.parse(await readFile(file, "utf8"));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      if (f.id === "hermes")
        feature = {
          ...feature,
          apiUrl: this.gateway.url,
          apiKey: this.gateway.token,
        };
      await atomicWrite(file, JSON.stringify(feature, null, 2));
    }
    await atomicWrite(marker, JSON.stringify(applied));
    this.stopping = false;
    this.state = "starting";
    this.gateway.botEpoch = randomUUID();
    this.child = fork(
      fileURLToPath(new URL("../bot.cjs", import.meta.url)),
      [],
      {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          SYNAPSE_PROFILE: this.paths.profile,
          SYNAPSE_HOME: this.paths.home,
          SYNAPSE_BOT_EPOCH: this.gateway.botEpoch,
        },
      },
    );
    this.stderr = "";
    this.child.stderr?.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-6000);
    });
    const worker = this.child;
    this.child.on("message", (msg: { type?: string; id?: string; error?: string; runId?: string; failed?: boolean; groupId?: string; eventId?: string; receipt?: VoiceReceipt; allowed?: boolean; throughGeneration?: number }) => {
      if (this.child !== worker) { return; }
      if (msg?.type === "group-send-result") {
        const pending = this.groupChecks.get(msg.id);
        if (msg.error || typeof msg.allowed !== "boolean") { pending?.reject(new Error(msg.error || "禁言检查没有返回状态")); }
        else { pending?.resolve(msg.allowed); }
      }
      if (msg?.type === "voice-result") {
        const pending = this.voices.get(msg.id);
        if (pending) {
          if (msg.error || !msg.receipt) { pending.reject(new Error(msg.error || "语音发送没有返回回执")); }
          else { pending.resolve(msg.receipt); }
        }
      }
      if (msg?.type === "ready") { this.state = "running"; this.updateActivity(); }
      if (msg?.type === "activity-ack") {
        const pending = this.activations.get(msg.id);
        if (pending) { clearTimeout(pending.timer); this.activations.delete(msg.id); if (msg.error) { pending.reject(new Error(msg.error)); } else { pending.resolve(); } }
      }
      if (msg?.type === "activity-finished") { void this.gateway.finishDelivery(msg.runId, msg.failed).catch(this.onError); }
      if (msg?.type === "group-muted") { void this.gateway.groupMuted(msg.groupId, msg.throughGeneration).catch(this.onError); }
      if (msg?.type === "activity-sent") {
        try { this.gateway.activity?.sent(msg.groupId, msg.eventId); }
        catch (cause) { this.onError(cause); }
      }
      if (msg?.type === "restart" && !this.stopping)
        void this.restart().catch(this.onError);
    });
    this.child.on("error", (e) => {
      this.state = "error";
      this.onError(e);
    });
    this.child.on("exit", (code) => {
      this.state = this.stopping ? "stopped" : `exited (${code})`;
      for (const pending of this.activations.values()) { clearTimeout(pending.timer); pending.reject(new Error("Bot 进程已退出")); }
      this.activations.clear();
      for (const pending of this.voices.values()) { pending.reject(new Error("Bot 进程已退出，语音发送未确认")); }
      for (const pending of this.groupChecks.values()) { pending.reject(new Error("Bot 进程已退出，禁言检查未确认")); }
      if (!this.stopping) { void this.gateway.botDisconnected().catch(this.onError); }
    });
    // Parent disconnect guarantees the upstream child cannot outlive its owner.
  }
  restart(): Promise<void> {
    if (!this.restarting) { this.restarting = this.stop().then(() => this.start()).finally(() => { this.restarting = undefined; }); }
    return this.restarting;
  }
  updateActivity() {
    if (this.child?.connected) {
      const c = this.config();
      this.child.send({ type: "activity-config", activity: c.activity, blockedUsers: c.modules.chat.blockedUsers }, error => { if (error) { this.onError(error); } });
    }
  }
  activate(event: IdleActivation): Promise<void> {
    if (!this.child?.connected || this.state !== "running") { return Promise.reject(new Error("Bot 尚未就绪")); }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.activations.delete(id); reject(new Error("Bot 主动事件提交超时")); }, 60000);
      this.activations.set(id, { resolve, reject, timer });
      this.child.send({ type: "activity-idle", id, event }, error => {
        if (error && this.activations.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  notify(event, payload) {
    if (this.child?.connected)
      this.child.send({ type: "github", event, payload }, (e) => {
        if (e) this.onError(e);
      });
  }
  /** 语音与取消使用同一 Bot 进程，等待平台回执后才通知模型发送成功。 */
  sendVoice: VoiceSender = async (route, audio, signal) => {
    signal.throwIfAborted();
    const child = this.child;
    if (!this.config().speech.enabled || !child?.connected || this.state !== "running") { throw new Error("语音功能已关闭或 Bot 尚未就绪"); }
    const id = randomUUID();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    let abort: () => void;
    try {
      return await new Promise<VoiceReceipt>((resolve, reject) => {
        abort = () => {
          if (child.connected) { child.send({ type: "voice-cancel", id }, error => { if (error) { this.onError(new Error("取消语音发送的 IPC 通知失败")); } }); }
          reject(requestSignal.reason);
        };
        this.voices.set(id, { resolve, reject });
        requestSignal.addEventListener("abort", abort, { once: true });
        if (requestSignal.aborted) { abort(); return; }
        child.send({ type: "voice-send", id, route, audio: audio.toString("base64") }, error => {
          if (error) { reject(new Error("Bot 语音发送 IPC 请求失败")); }
        });
      });
    } finally {
      requestSignal.removeEventListener("abort", abort);
      this.voices.delete(id);
    }
  };
  /** 原生 OneBot 工具与普通发送共享子进程中的禁言缓存。 */
  async canSendGroup(groupId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const child = this.child;
    if (!child?.connected || this.state !== "running") { throw new Error("Bot 尚未就绪，无法检查禁言状态"); }
    const id = randomUUID();
    try {
      const task = new Promise<boolean>((resolve, reject) => {
        this.groupChecks.set(id, { resolve, reject });
        child.send({ type: "group-send-check", id, groupId }, error => { if (error) { reject(new Error("禁言检查 IPC 请求失败")); } });
      });
      return await abortable(task, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
    } finally { this.groupChecks.delete(id); }
  }
  async stop() {
    this.stopping = true;
    for (const pending of this.voices.values()) { pending.reject(new Error("Bot 已停止，语音发送未确认")); }
    for (const pending of this.groupChecks.values()) { pending.reject(new Error("Bot 已停止，禁言检查未确认")); }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const done = once(child, "exit").catch(() => {});
      child.kill();
      await done;
    }
    await this.gateway.botDisconnected();
    this.state = "stopped";
  }
  async liveFeatures() {
    const root = path.join(this.paths.data, "bot", "configs", "features");
    let files;
    try {
      files = await readdir(root);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const result = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(await readFile(path.join(root, file), "utf8"));
      if (file === "hermes.json") {
        delete data.apiKey;
        delete data.apiUrl;
      }
      result.push({ id: file.slice(0, -5), value: data });
    }
    try {
      result.push({
        id: "peak-valley-timer",
        value: JSON.parse(
          await readFile(path.join(root, "../peak-valley-timer.json"), "utf8"),
        ),
      });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return result;
  }
}
