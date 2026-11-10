import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDiscordDeliverable, readDeliverable, sendDiscordDeliverable } from "../lib/host/bot-deliverables.js";
import { QQSendQueue } from "../lib/host/qq-send-queue.js";

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
    request: async action => { requests.push(action); },
    groupSignal: () => group.signal,
    onError: error => assert.fail(error),
  }, 0);
  try {
    const discarded = queue.upload("group", "100", "base64://Zg==", "report.txt");
    const sent = queue.upload("private", "200", "base64://Zg==", "report.txt");
    group.abort();
    queue.discardAbortedGroup("100");
    assert.deepEqual(await Promise.all([discarded, sent]), [false, true]);
    assert.deepEqual(requests, ["upload_private_file"]);
  } finally {
    queue.close();
  }
});
