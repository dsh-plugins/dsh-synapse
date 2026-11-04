import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fork, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ConfigSource } from "./types.js";
import { onlineEmbed, onlineEmbedMany, onlineRerank } from "./online-models.js";
import { abortable } from "./abort.js";
const VERSION = "3.8.1";
export async function installRuntime(root: string, signal?: AbortSignal) {
  await mkdir(root, { recursive: true });
  const file = path.join(root, "package.json");
  const manifest = {
    name: "dsh-synapse-inference-runtime",
    private: true,
    version: "1.0.0",
    dependencies: { "@huggingface/transformers": VERSION },
  };
  try {
    const req = createRequire(file);
    req.resolve("@huggingface/transformers");
    const pkg = JSON.parse(
      await readFile(
        path.join(root, "node_modules/@huggingface/transformers/package.json"),
        "utf8",
      ),
    );
    if (pkg.version === VERSION) return file;
  } catch {}
  await writeFile(file, JSON.stringify(manifest, null, 2));
  // npm is launched without a command shell, including on Windows.
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    ),
    path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .flatMap((dir) => [
        path.join(dir, "node_modules/npm/bin/npm-cli.js"),
        path.resolve(dir, "../lib/node_modules/npm/bin/npm-cli.js"),
      ]),
    ...(process.platform === "win32"
      ? []
      : ["/usr/share/nodejs/npm/bin/npm-cli.js"]),
  ].filter(Boolean);
  let npm;
  for (const c of candidates) {
    try {
      await readFile(c);
      npm = c;
      break;
    } catch {}
  }
  if (!npm) throw new Error("找不到 npm-cli.js；请安装 Node.js 的 npm 组件");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [npm, "install", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: root, windowsHide: true, stdio: "ignore", signal },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("推理运行时安装超时"));
    }, 600000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`推理运行时安装失败 (${code})`));
    });
  });
  return file;
}
export class Inference {
  data: string;
  pending: Map<
    number,
    {
      resolve: (value: number[]) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  counter: number;
  closed: boolean;
  starting: Promise<void>;
  worker: ChildProcess;
  private stopped: Promise<void>;
  private closing: Promise<void>;
  installer = new AbortController();

  constructor(data: string, private config?: ConfigSource) {
    this.data = data;
    this.pending = new Map();
    this.counter = 0;
    this.closed = false;
  }
  async start() {
    if (this.closed) {
      throw new Error("推理进程已关闭");
    }
    if (!this.starting) {
      this.starting = (async () => {
        const manifest = await installRuntime(
          path.join(this.data, "runtime"),
          this.installer.signal,
        );
        if (this.closed) {
          throw new Error("推理进程已关闭");
        }
        // Windows 工作线程仍共享 DLL，独立进程才能隔离 Transformers 与宿主的 sharp。
        this.worker = fork(
          new URL("./inference-worker.js", import.meta.url),
          [manifest, path.join(this.data, "models")],
          {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
            execArgv: [],
          },
        );
        let diagnostic = "";
        this.worker.stderr.on("data", (chunk) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-6000);
        });
        this.worker.on(
          "message",
          ({ id, value, error }: { id: number; value?: number[]; error?: string }) => {
            const p = this.pending.get(id);
            if (!p) {
              return;
            }
            clearTimeout(p.timer);
            this.pending.delete(id);
            error ? p.reject(new Error(error)) : p.resolve(value);
          },
        );
        this.worker.on("error", (error) => {
          this.closed = true;
          this.fail(error);
          this.worker.kill();
        });
        this.stopped = new Promise((resolve) => {
          this.worker.once("close", (code, signal) => {
            this.closed = true;
            this.fail(new Error(
              `推理进程退出 (${code ?? signal})${diagnostic.trim() ? ": " + diagnostic.trim() : ""}`,
            ));
            resolve();
          });
        });
      })();
    }
    return this.starting;
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  async call(method, args) {
    await this.start();
    if (this.closed || !this.worker.connected) {
      throw new Error("推理进程已关闭");
    }
    if (this.pending.size >= 100) {
      throw new Error("推理队列已满");
    }
    return new Promise<number[]>((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("模型下载或推理超时"));
      }, 600000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.send({ id, method, args }, (error) => {
        if (error && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new Error(`推理请求发送失败：${error.message}`, { cause: error }));
        }
      });
    });
  }
  private requestSignal(signal?: AbortSignal): AbortSignal {
    if (this.closed) { throw new Error("模型推理已关闭"); }
    const combined = AbortSignal.any([this.installer.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    return combined;
  }
  async embed(text: string, query = false, signal?: AbortSignal) {
    const combined = this.requestSignal(signal);
    const model = this.config?.().memory.embeddingModel;
    return model?.source === "online" ? onlineEmbed(model, text, combined) : abortable(this.call("embed", { text, query }), combined);
  }
  async embedMany(texts: string[], signal?: AbortSignal) {
    const combined = this.requestSignal(signal);
    const model = this.config?.().memory.embeddingModel;
    if (model?.source === "online") { return onlineEmbedMany(model, texts, combined); }
    const vectors: number[][] = [];
    for (const text of texts) { vectors.push(await this.embed(text, false, combined)); }
    return vectors;
  }
  async rerank(query: string, documents: string[], signal?: AbortSignal) {
    const combined = this.requestSignal(signal);
    const model = this.config?.().memory.rerankModel;
    return model?.source === "online" ? onlineRerank(model, query, documents, combined) : abortable(this.call("rerank", { query, documents }), combined);
  }
  close() {
    if (!this.closing) {
      this.closed = true;
      this.installer.abort(new Error("模型推理已关闭"));
      this.fail(new Error("推理进程已关闭"));
      this.closing = (async () => {
        // 启动错误由原请求返回，关闭时等待安装任务结束再回收子进程。
        await Promise.allSettled(this.starting ? [this.starting] : []);
        if (this.worker) {
          this.worker.kill();
          await this.stopped;
        }
      })();
    }
    return this.closing;
  }
}
