import type { AvailableTool, ChatRoute, ConfigSource, SpeechConfig, VoiceSender } from "./types.js";
import { nativeTool, textArgument } from "./native-tools.js";

class SpeechError extends Error {}

function endpoint(base: string): URL {
  let url: URL;
  try { url = new URL(base); }
  catch { throw new Error("BreezeBlue 服务地址无效"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("BreezeBlue 地址须为 HTTP(S)，不能包含账号、查询参数或片段；请使用 API Key 配置鉴权");
  }
  url.pathname = url.pathname.replace(/\/?$/, "/");
  return url;
}

/** 保存配置和执行工具时使用同一校验，未启用时允许先填写部分凭据。 */
export function validateSpeech(c: SpeechConfig): void {
  endpoint(c.baseUrl);
  if (c.apiKey && (!c.apiKey.trim() || /[\s\x00-\x1f\x7f]/.test(c.apiKey))) {
    throw new Error("BreezeBlue API Key 不能包含空白或控制字符");
  }
  if (c.voiceId && !/^[A-Za-z0-9_-]{1,128}$/.test(c.voiceId)) {
    throw new Error("BreezeBlue 音色 ID 仅支持字母、数字、短横线和下划线");
  }
  if (c.modelId.length > 120 || c.modelId && !c.modelId.trim()) {
    throw new Error("BreezeBlue 模型 ID 最多 120 字符");
  }
  if (c.languageCode && !/^[a-z]{2}$/.test(c.languageCode)) {
    throw new Error("语音语言代码须为两位小写字母，或留空自动识别");
  }
  if (c.instructions.length > 2000) { throw new Error("默认朗读风格最多 2000 字符"); }
  if (!Number.isInteger(c.maxCharacters) || c.maxCharacters < 1 || c.maxCharacters > 2000) { throw new Error("语音字符上限须为 1–2000 的整数"); }
  if (!Number.isInteger(c.timeoutSec) || c.timeoutSec < 1 || c.timeoutSec > 300) { throw new Error("语音超时须为 1–300 的整数秒"); }
  if (c.enabled && (!c.apiKey || !c.voiceId)) { throw new Error("启用语音合成需要 API Key 和音色 ID"); }
}

/** 使用同步 MP3 接口，完整接收后才发送，避免把半段音频交给聊天平台。 */
export async function synthesizeSpeech(c: SpeechConfig, text: string, instructions: string | undefined, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  validateSpeech(c);
  if (!c.enabled) { throw new Error("语音合成已关闭"); }
  if (typeof text !== "string" || !text.trim() || Array.from(text).length > c.maxCharacters) {
    throw new Error(`朗读内容须为非空文本，最多 ${c.maxCharacters} 字符`);
  }
  if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > 2000)) {
    throw new Error("朗读风格须为文本，最多 2000 字符");
  }
  const url = new URL(`text-to-speech/${encodeURIComponent(c.voiceId)}`, endpoint(c.baseUrl));
  url.searchParams.set("output_format", "mp3");
  url.searchParams.set("delivery", "sync");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(c.timeoutSec * 1000)]);
  try {
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: requestSignal,
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg", "xi-api-key": c.apiKey },
      body: JSON.stringify({ text, ...(c.modelId ? { model_id: c.modelId } : {}),
        ...(c.languageCode ? { language_code: c.languageCode } : {}),
        ...((instructions?.trim() || c.instructions.trim()) ? { instructions: instructions?.trim() || c.instructions.trim() } : {}) }),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) { throw new SpeechError("BreezeBlue 未返回音频"); }
    const reader = response.body.getReader();
    try {
      if (response.status !== 200) { throw new SpeechError(`BreezeBlue 合成失败（HTTP ${response.status}），请检查凭据、音色、额度及服务状态`); }
      if (!/^audio\/(?:mpeg|mp3)(?:;|$)/i.test(response.headers.get("content-type") || "")) {
        throw new SpeechError("BreezeBlue 未返回 MP3 音频");
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        size += value.byteLength;
        if (size > 10 * 1024 * 1024) { throw new SpeechError("合成音频超过 10 MB，请缩短朗读内容"); }
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    requestSignal.throwIfAborted();
    const audio = Buffer.concat(chunks);
    if (audio.length < 4 || !(audio.subarray(0, 3).toString("ascii") === "ID3" || audio[0] === 255 && (audio[1] & 224) === 224)) {
      throw new SpeechError("BreezeBlue 返回的 MP3 音频为空或格式无效");
    }
    return audio;
  } catch (error) {
    if (signal.aborted) { throw signal.reason; }
    if (requestSignal.aborted) { throw new Error("BreezeBlue 语音合成超时，请缩短朗读内容或调整超时设置"); }
    if (error instanceof SpeechError) { throw error; }
    throw new Error("BreezeBlue 语音请求失败，请检查服务地址与网络连接");
  }
}

/** 模型只能合成并发送到当前会话，API Key、目标和输出格式均由宿主控制。 */
export function speechTools(config: ConfigSource, route?: ChatRoute, send?: VoiceSender): AvailableTool[] {
  if (!config().speech.enabled || !route || !send) { return []; }
  return [nativeTool("synapse_send_voice",
    "将 text 合成为语音并直接发送到当前聊天会话。可以在适合口语表达、用户要求朗读或语音回复时主动调用。instructions 可描述语气、情绪与朗读方式，应与正文使用相同语言；省略则使用配置的风格。不要朗读密钥或无关的长篇内容，不要更改发送目标。仅在 sent=true 时确认已发送；发送成功后无需重复朗读正文，可以不再输出文字。未确认发送的请求可能已送达，切勿盲目重试。",
    { text: { type: "string", minLength: 1, maxLength: 2000 }, instructions: { type: "string", maxLength: 2000 } }, ["text"],
    async (args, signal) => {
      const text = textArgument(args, "text", 4000);
      const audio = await synthesizeSpeech(config().speech, text, args.instructions as string | undefined, signal);
      signal.throwIfAborted();
      if (!config().speech.enabled) { throw new Error("语音合成已关闭，音频未发送"); }
      const receipt = await send(route, audio, signal);
      return { sent: true, ...receipt, characters: Array.from(text).length, bytes: audio.length };
    })];
}
