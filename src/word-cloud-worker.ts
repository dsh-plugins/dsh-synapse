import { parentPort, workerData } from "node:worker_threads";
import { CloudStore } from "./word-cloud-core.js";

const cloud = new CloudStore(workerData.file);
parentPort.on("message", request => {
  try {
    let result;
    if (request.action === "message") {
      // 必须先查询旧统计，再记入当前消息。
      result = cloud.evaluate(request.groupId, request.text, request.now, request.settings);
      cloud.observe(request.groupId, request.messageId, request.sender, request.text, request.time, request.now);
    } else if (request.action === "recover") {
      cloud.recover(request.now);
    } else if (request.action === "remove") {
      cloud.removeUsers(request.users);
    } else if (request.action === "close") {
      cloud.close(); parentPort.postMessage({ id: request.id }); parentPort.close(); return;
    }
    parentPort.postMessage({ id: request.id, result });
  } catch {
    parentPort.postMessage({ id: request.id, error: "词云统计失败" });
  }
});
