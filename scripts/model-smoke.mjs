import { Inference } from "../lib/host/runtime.js";
import path from "node:path";
const inference = new Inference(path.resolve(".runtime-test"));
try {
  console.log(
    "Installing isolated inference runtime and downloading embedding model...",
  );
  const vector = await inference.embed("猫喜欢吃鱼");
  if (vector.length !== 512 || vector.some((x) => !Number.isFinite(x)))
    throw new Error("Invalid embedding");
  console.log(
    JSON.stringify({
      embeddingDimensions: vector.length,
      norm: Math.hypot(...vector),
    }),
  );
  if (process.argv.includes("--rerank")) {
    console.log("Downloading reranker...");
    console.log(
      await inference.rerank("猫吃什么", ["猫喜欢吃鱼", "天空是蓝色的"]),
    );
  }
} finally {
  await inference.close();
}
