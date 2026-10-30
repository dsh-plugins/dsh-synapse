import { build } from "esbuild";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
await mkdir("lib", { recursive: true });
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], {
  stdio: "inherit",
});
await copyFile("src/panel.html", "lib/host/panel.html");
const vendor = path.resolve("vendor/gugle-chat-bot");
// Patches are applied at build time, keeping the pinned source auditable.
await build({
  entryPoints: [`${vendor}/src/index.ts`],
  outfile: "lib/bot.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  packages: "external",
  tsconfig: `${vendor}/tsconfig.json`,
  sourcemap: true,
  plugins: [
    {
      name: "synapse-adapter",
      setup(b) {
        b.onLoad({ filter: /\.ts$/ }, async ({ path: file }) => {
          let contents = (await readFile(file, "utf8")).replaceAll(
            "\r\n",
            "\n",
          );
          if (file.endsWith(path.join("config", "manager.ts"))) {
            // Poll files to avoid the Windows libuv directory watcher assertion on
            // redirected profile/temp folders. Preserve ConfigStore hot reload.
            contents = contents
              .replace(
                "private watcher: fs.FSWatcher | undefined",
                "private watcher: { close(): void } | undefined",
              )
              .replace(
                "this.watcher = fs.watch(dir, (_event, changedFile) => {",
                "const listener = () => { const changedFile = filename;",
              )
              .replace(
                "    });\n  }\n\n  /** 停止文件监听 */",
                "    };\n    fs.watchFile(resolved, { interval: 1000 }, listener);\n    this.watcher = { close: () => fs.unwatchFile(resolved, listener) };\n  }\n\n  /** 停止文件监听 */",
              );
          }
          if (file === path.join(vendor, "src", "index.ts"))
            contents = contents.replace(
              "github.start(botConfig.githubPort);",
              `
        process.on('message', (message: any) => {
          if (message?.type === 'github') void github.post('github-' + message.event, bot, message.payload);
        });
        process.on('disconnect', () => process.exit(0));
        process.send?.({ type: 'ready' });`,
            );
          if (file.endsWith(path.join("src", "custom.ts")))
            contents = contents.replace(
              "const result = await restartApplication();",
              "process.send?.({ type: 'restart' }); return; const result = await restartApplication();",
            );
          if (file.endsWith(path.join("hermes", "index.ts")))
            contents = contents.replace(
              "const soulPath = path.resolve(process.cwd(), 'configs', 'SOUL.md');",
              "const soulPath = [process.env.SYNAPSE_PROFILE, process.env.SYNAPSE_HOME].filter(Boolean).map(dir => path.join(dir!, 'SOUL.md')).find(file => fs.existsSync(file)) || path.resolve(process.cwd(), 'configs', 'SOUL.md');",
            );
          return { contents, loader: "ts" };
        });
      },
    },
  ],
});
await build({
  entryPoints: ["src/client.ts"],
  outfile: "lib/client.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  banner: {
    js: 'window.__ModuleLoader__.load({id:"@dsh-plugin/dsh-synapse",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: "return module.exports;}});" },
});
await writeFile(
  "lib/build.json",
  JSON.stringify({ upstream: "018cd46565149877ee6822968a817932f7390ef8" }),
);
