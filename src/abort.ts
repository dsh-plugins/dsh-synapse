/** 单轮时限从任务开始执行时计时，并保留调用方的取消信号。 */
export function turnSignal(timeoutSec: number, ...signals: AbortSignal[]): AbortSignal {
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  if (timeoutSec === 0) {
    throw new DOMException("单次任务已超时", "TimeoutError");
  }
  return timeoutSec === -1 ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000)]);
}

/** Stop this caller's wait without terminating shared model downloads or MCP connections. */
export function abortable<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
