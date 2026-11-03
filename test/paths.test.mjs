import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { pathsFor } from "../lib/host/files.js";

const profile = path.resolve("example", "profiles", "foo");
const baseUrl = pathToFileURL(profile + path.sep).href;

test("默认读取当前进程的 DSH_HOME", () => {
  const previous = process.env.DSH_HOME;
  const home = path.resolve("example home");
  process.env.DSH_HOME = home;
  try {
    assert.equal(pathsFor({ baseUrl }).home, home);
  } finally {
    if (previous === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previous;
    }
  }
});

test("宿主上下文定位当前 profile，DSH_HOME 独立决定主目录", () => {
  const home = path.resolve("bar home");
  for (const ctx of [
    { baseUrl },
    { get: () => ({ ctx: { baseUrl } }) },
    { get: () => ({ config: { baseUrl } }) },
  ]) {
    const paths = pathsFor(ctx, { DSH_HOME: home });
    assert.equal(paths.profile, profile);
    assert.equal(paths.home, home);
    assert.equal(paths.data, path.join(profile, "data", "dsh-synapse"));
    assert.equal(paths.skills, path.join(profile, "skills"));
  }
});

test("DSH_HOME 沿用宿主的相对路径与用户主目录解析规则", () => {
  for (const [input, home] of [
    ["example", path.resolve("example")],
    ["~", os.homedir()],
    ["~/example", path.join(os.homedir(), "example")],
    ["~\\example", path.join(os.homedir(), "example")],
  ]) {
    assert.equal(pathsFor({ baseUrl }, { DSH_HOME: input }).home, home);
  }
  for (const env of [{}, { DSH_HOME: "" }, { DSH_HOME: "  " }]) {
    assert.equal(
      pathsFor({ baseUrl }, env).home,
      path.resolve(profile, "../.."),
    );
  }
});

test("自动定位失败时报告宿主信息缺失，DSH_HOME 不用于猜测 profile", () => {
  assert.throws(
    () => pathsFor({}, { DSH_HOME: path.resolve("example") }),
    /profile/,
  );
});
