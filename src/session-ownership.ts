import type { HostAPI } from "@dsh-plugin/dsh-loader";
import { abortable } from "./abort.js";

/** 仅使用原生工厂返回的句柄释放写入权，不改动持久化锁文件。 */
export class SessionOwnership {
  private handles = new WeakMap<object, any>();
  private patches: { dispose(): void }[] = [];
  constructor(private loader: HostAPI) {
    const agents = loader.services.get("agents");
    if (!agents || !loader.patch?.method) { return; }
    try {
      for (const method of ["create", "resume"] as const) {
        let target = agents;
        while (target && !Object.hasOwn(target, method)) { target = Object.getPrototypeOf(target); }
        if (!target || typeof target[method] !== "function") { continue; }
        const handles = this.handles;
        this.patches.push(loader.patch.method(target, method, original => async function (...args) {
          const handle = await Reflect.apply(original as Function, this, args);
          handles.set(handle.agent, handle);
          return handle;
        }));
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async release(id: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const live = this.loader.services.get("agents")?.get?.(id);
    const handle = live && this.handles.get(live);
    if (!handle) { return !live; }
    await abortable(handle.dispose(), signal);
    this.handles.delete(live);
    return !this.loader.services.get("agents")?.get?.(id);
  }

  close() {
    for (const patch of this.patches.splice(0).reverse()) { patch.dispose(); }
    this.handles = new WeakMap();
  }
}
