import { Worker } from "node:worker_threads";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
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
  worker: Worker;
  installer = new AbortController();

  constructor(data: string) {
    this.data = data;
    this.pending = new Map();
    this.counter = 0;
    this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error("推理 Worker 已关闭");
    if (!this.starting)
      this.starting = (async () => {
        const manifest = await installRuntime(
          path.join(this.data, "runtime"),
          this.installer.signal,
        );
        if (this.closed) throw new Error("推理 Worker 已关闭");
        this.worker = new Worker(
          new URL("./inference-worker.js", import.meta.url),
          { workerData: { manifest, cache: path.join(this.data, "models") } },
        );
        this.worker.on("message", ({ id, value, error }) => {
          const p = this.pending.get(id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(id);
          error ? p.reject(new Error(error)) : p.resolve(value);
        });
        const fail = (e) => {
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(e);
          }
          this.pending.clear();
        };
        this.worker.on("error", fail);
        this.worker.on("exit", (code) => {
          this.closed = true;
          fail(new Error(`推理 Worker 退出 (${code})`));
        });
      })();
    return this.starting;
  }
  async call(method, args) {
    await this.start();
    if (this.closed) throw new Error("推理 Worker 已关闭");
    if (this.pending.size >= 100) throw new Error("推理队列已满");
    return new Promise<number[]>((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("模型下载或推理超时"));
      }, 600000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  embed(text, query = false) {
    return this.call("embed", { text, query });
  }
  rerank(query, documents) {
    return this.call("rerank", { query, documents });
  }
  async close() {
    this.closed = true;
    this.installer.abort();
    await this.starting?.catch(() => {});
    await this.worker?.terminate();
  }
}
