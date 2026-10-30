import type { ConfigSource, PluginPaths, ErrorSink } from "./types.js";
import { fork } from "node:child_process";
import { mkdir, cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { atomicWrite } from "./files.js";
import { featureFiles } from "./feature-config.js";
export class Bot {
  paths: PluginPaths;
  config: ConfigSource;
  gateway: import("./gateway.js").Gateway;
  onError: ErrorSink;
  state: string;
  stopping: boolean;
  child: import("node:child_process").ChildProcess;
  stderr: string;

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
    await atomicWrite(
      path.join(cwd, "configs", "bot-config.json"),
      JSON.stringify({
        userAgent: c.userAgent,
        tokenParams: c.tokenParams,
        httpUrl: c.httpUrl,
        wsUrl: c.wsUrl,
        httpToken: c.httpToken,
        wsToken: c.wsToken,
        chromePath: c.chromePath,
        githubAllowedRepositories: c.repositories.split(/\s+/).filter(Boolean),
        logLevel: c.logLevel,
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
        },
      },
    );
    this.stderr = "";
    this.child.stderr?.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-6000);
    });
    this.child.on("message", (msg: { type?: string }) => {
      if (msg?.type === "ready") this.state = "running";
      if (msg?.type === "restart" && !this.stopping)
        void this.restart().catch(this.onError);
    });
    this.child.on("error", (e) => {
      this.state = "error";
      this.onError(e);
    });
    this.child.on("exit", (code) => {
      this.state = this.stopping ? "stopped" : `exited (${code})`;
    });
    // Parent disconnect guarantees the upstream child cannot outlive its owner.
  }
  async restart() {
    await this.stop();
    await this.start();
  }
  notify(event, payload) {
    if (this.child?.connected)
      this.child.send({ type: "github", event, payload }, (e) => {
        if (e) this.onError(e);
      });
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const done = once(child, "exit").catch(() => {});
      child.kill();
      await done;
    }
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
