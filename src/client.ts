export const inject = ["dshLoaderUi"];
export function apply(ctx) {
  const ui = ctx.dshLoaderUi ?? ctx.get?.("dshLoaderUi");
  ctx.effect(() =>
    ui.mount("settings.nav", {
      id: "synapse:management",
      render(mount) {
        const link = document.createElement("a");
        link.href = "/synapse";
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Synapse · 通道与记忆";
        link.style.cssText =
          "display:block;padding:10px;color:inherit;font:inherit";
        mount.append(link);
        return () => link.remove();
      },
    }),
  );
}
