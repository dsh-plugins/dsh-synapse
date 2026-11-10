import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDiscordDeliverable, readDeliverable, sendDiscordDeliverable, sendOneBotDeliverable } from "../lib/host/bot-deliverables.js";
import { QQSendQueue } from "../lib/host/qq-send-queue.js";

test("OneBot accepts explicit success without a message ID and never resends ambiguous deliveries", async () => {
  const payload = { group_id: "100", message: [{ type: "image", data: { file: "base64://Zg==" } }] };
  const signal = new AbortController().signal;
  for (const [data, expected] of [
    [{ status: "ok", retcode: 0, data: null }, "sent"],
    [{ status: "ok", retcode: "0" }, "sent"],
    [{ status: "failed", retcode: 1200, message: "EventChecker Failed" }, "unconfirmed"],
    [{ status: "failed", retcode: 100, wording: "发送超时" }, "unconfirmed"],
    [{ status: "async", retcode: 1 }, "unconfirmed"],
    [{ status: "failed", retcode: 0 }, "unconfirmed"],
    [{ status: "failed", retcode: 1401 }, "failed"],
    [{}, "unconfirmed"],
    [undefined, "unconfirmed"],
  ]) {
    const requests = [];
    const api = { post: async (url, body) => {
      requests.push({ url, body });
      if (data === undefined) { throw new Error("socket closed after write"); }
      return { status: 200, data };
    } };
    const result = await sendOneBotDeliverable(api, "send_group_msg", payload, signal);
    assert.equal(result.status, expected, JSON.stringify(data));
    assert.deepEqual(requests, [{ url: "/send_group_msg", body: payload }]);
  }
});

test("Discord receives the named upload with its media type and a nonce to suppress mirroring", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synapse-deliverables-"));
  const signal = new AbortController().signal;
  const requests = [];
  const rest = { post: async (route, options) => { requests.push({ route, ...options }); return { id: "42" }; } };
  try {
    const inputs = [
      ["preview", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lKcAAAAASUVORK5CYII=", "base64"), "preview.png", "image/png"],
      ["demo.mp4", Buffer.from("000000186674797069736f6d0000020069736f6d6d703431", "hex"), "demo.mp4", "video/mp4"],
      ["report.txt", Buffer.from("report"), "report.txt", "text/plain"],
    ];
    for (const [name, data] of inputs) {
      const file = path.join(root, name);
      await writeFile(file, data);
      await sendDiscordDeliverable(rest, "300", await readDeliverable(file, "discord", signal), signal);
    }
    assert.deepEqual(requests.map(item => [item.route, ...item.files]), inputs.map(([, data, name, contentType]) => ["/channels/300/messages", { data, name, contentType }]));
    assert(requests.every(item => isDiscordDeliverable(item.body.nonce)));
    assert.equal(new Set(requests.map(item => item.body.nonce)).size, inputs.length);
    assert.equal(isDiscordDeliverable("unrelated"), false);
    const svg = path.join(root, "vector");
    await writeFile(svg, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    await assert.rejects(sendDiscordDeliverable(rest, "300", await readDeliverable(svg, "discord", signal), signal), /image\/svg\+xml/);
    assert.equal(requests.length, inputs.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QQ drops queued file uploads when the group generation is muted and keeps other conversations running", async () => {
  const group = new AbortController();
  const requests = [];
  const queue = new QQSendQueue({
    deliver: async action => { requests.push(action); return { status: "sent" }; },
    groupSignal: () => group.signal,
    onError: error => assert.fail(error),
  }, 0);
  try {
    const file = { type: "file", file: "base64://Zg==", name: "report.txt" };
    const discarded = queue.deliver("group", "100", file);
    const sent = queue.deliver("private", "200", file);
    group.abort();
    queue.discardAbortedGroup("100");
    assert.deepEqual((await Promise.all([discarded, sent])).map(receipt => receipt.status), ["failed", "sent"]);
    assert.deepEqual(requests, ["upload_private_file"]);
  } finally {
    queue.close();
  }
});

test("cancelling a OneBot request in progress leaves the delivery unconfirmed", async () => {
  const group = new AbortController();
  const started = Promise.withResolvers();
  const queue = new QQSendQueue({
    deliver: async (_action, _payload, signal) => {
      started.resolve();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      return { status: "unconfirmed", reason: "连接关闭" };
    },
    groupSignal: () => group.signal,
    onError: error => assert.fail(error),
  }, 0);
  try {
    const sending = queue.deliver("group", "100", { type: "image", file: "base64://Zg==" });
    await started.promise;
    group.abort();
    queue.discardAbortedGroup("100");
    assert.equal((await sending).status, "unconfirmed");
  } finally {
    queue.close();
  }
});
