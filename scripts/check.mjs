import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const folder of ["src", "scripts", "test"]) {
  for (const entry of await readdir(folder, { recursive: true })) {
    if (!entry.endsWith(".mjs")) continue;
    const result = spawnSync(
      process.execPath,
      ["--check", `${folder}/${entry}`],
      { stdio: "inherit" },
    );
    if (result.status) process.exit(result.status);
  }
}
