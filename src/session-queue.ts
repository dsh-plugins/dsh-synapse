/** FIFO per conversation; cancellation of a waiting item never stops its predecessor. */
export class SessionQueue {
  private queues = new Map<
    string,
    { tail: Promise<void>; jobs: Set<AbortController> }
  >();
  private closed = false;

  run<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("会话队列已关闭"));
    const queue = this.queues.get(key) ?? {
      tail: Promise.resolve(),
      jobs: new Set<AbortController>(),
    };
    this.queues.set(key, queue);
    const controller = new AbortController();
    queue.jobs.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      ...(caller ? [caller] : []),
    ]);
    const task = queue.tail.then(() => {
      signal.throwIfAborted();
      return work(signal);
    });
    queue.tail = task
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        queue.jobs.delete(controller);
        if (!queue.jobs.size) this.queues.delete(key);
      });
    // Return cancellation promptly even if an earlier message is still running.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      task
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  reset<T>(key: string, work: () => Promise<T>) {
    for (const job of this.queues.get(key)?.jobs ?? [])
      job.abort(new Error("会话上下文已清空"));
    return this.run(key, work);
  }
  async close() {
    this.closed = true;
    const queues = [...this.queues.values()];
    for (const queue of queues)
      for (const job of queue.jobs) job.abort(new Error("插件正在关闭"));
    await Promise.all(queues.map((q) => q.tail));
  }
}
