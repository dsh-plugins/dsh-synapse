import { unlink } from "node:fs/promises";
import type { ConfigOperationContext } from "@dsh-plugin/dsh-loader/config";
import { ConfigError } from "@dsh-plugin/dsh-loader/config";
import { atomicWrite, instructionFor, revisionOf, safePath } from "./files.js";
import type { Channel, PluginPaths, SynapseConfig } from "./types.js";

type Request = ConfigOperationContext<SynapseConfig>;
type Service = { paths: PluginPaths };

function channelFor(request: Request): Channel {
  const channel = request.input.channel;
  if (channel !== "chat" && channel !== "review") throw new ConfigError("validation", "请选择聊天或审查通道");
  return channel;
}

async function read({ paths }: Service, request: Request) {
  const channel = channelFor(request);
  const file = await instructionFor(paths, channel, request.signal);
  const name = channel === "review" ? "AGENTS.md" : "SOUL.md";
  return {
    value: { name, content: file.content, source: file.displayPath, override: file.displayPath === `<profile>/${name}` },
    resource: { id: `instructions:${channel}`, revision: revisionOf(file.displayPath + "\0" + file.content) },
  };
}

// registerOperations dispatches both writes through the profile's serialized service queue.
async function change(service: Service, request: Request, inherit: boolean) {
  const current = await read(service, request);
  if (current.resource.id !== request.resource?.id || current.resource.revision !== request.resource.revision) {
    throw new ConfigError("conflict", "规则文件已变更，请重新载入后再编辑");
  }
  const file = await safePath(service.paths.profile, current.value.name);
  request.signal.throwIfAborted();
  if (inherit) {
    if (!current.value.override) throw new ConfigError("validation", "当前规则已在继承");
    await unlink(file);
  } else {
    if (typeof request.input.content !== "string") throw new ConfigError("validation", "请填写 Markdown 正文");
    await atomicWrite(file, request.input.content, request.signal);
  }
  return read(service, request);
}

export const instructionOperations = {
  "instructions.read": read,
  "instructions.save": (service: Service, request: Request) => change(service, request, false),
  "instructions.inherit": (service: Service, request: Request) => change(service, request, true),
};
