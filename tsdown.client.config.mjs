/**
 * dsh-synapse client-bundle build (tsdown) — the standard DSH client pipeline:
 * plain-ESM source bundled to CJS and wrapped in the __ModuleLoader__.load
 * shell the web profile requires. React / react-dom / @dsh-plugin/dsh-loader/client
 * stay external: the web shell and the loader bundle own those shared modules.
 */
import { fileURLToPath } from "node:url";

const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@dsh-plugin/dsh-loader/client",
];

export default {
  entry: {
    client: fileURLToPath(new URL("./src/client/index.tsx", import.meta.url)),
  },
  outDir: fileURLToPath(new URL("./lib", import.meta.url)),
  format: "cjs",
  platform: "browser",
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  inputOptions: {
    resolve: {
      conditionNames: ["browser", "import", "require", "default"],
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "production",
    ),
  },
  outputOptions: {
    entryFileNames: "client.js",
    banner:
      'window.__ModuleLoader__.load({ id: "@dsh-plugin/dsh-synapse", factory: (require) => {',
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
    codeSplitting: false,
  },
};
