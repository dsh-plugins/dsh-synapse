export const env = {};
let count = 0;

export async function pipeline() {
  return async (text) => {
    if (text === "fail") {
      throw new Error("推理测试错误");
    }
    if (text === "crash") {
      process.stderr.write("推理进程测试崩溃\n", () => process.exit(7));
      return new Promise(() => {});
    }
    if (text === "wait") {
      return new Promise(() => {});
    }
    if (text === "disconnect") {
      process.disconnect();
      return new Promise(() => {});
    }
    return {
      data: Float32Array.from([
        process.pid,
        ++count,
        text.startsWith("为这个句子生成表示") ? 1 : 0,
      ]),
    };
  };
}

export const AutoTokenizer = {
  from_pretrained: async () => (_queries, options) => ({
    documents: options.text_pair,
  }),
};

export const AutoModelForSequenceClassification = {
  from_pretrained:
    async () =>
    async ({ documents }) => ({
      logits: {
        data: Float32Array.from(documents.map((document) => document.length)),
      },
    }),
};
