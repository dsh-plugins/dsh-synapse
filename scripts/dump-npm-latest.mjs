import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

// 与其他 DSH 插件保持一致：正式版发布后将 registry 的 latest 元数据回写仓库。
const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expected = process.env.EXPECTED_VERSION;
const attempts = expected ? 11 : 1;
let metadata;
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'cache-control': 'no-cache' },
    });
    if (!response.ok) {
      throw new Error(`Registry request failed: ${response.status} ${response.statusText} (${registry})`);
    }
    const candidate = await response.json();
    const latest = candidate['dist-tags']?.latest;
    if (!latest) throw new Error(`${pkg.name}: no latest dist-tag on ${registry}`);
    if (expected && latest !== expected) {
      throw new Error(`${pkg.name}: latest is ${latest}; waiting for ${expected}`);
    }
    if (!candidate.versions?.[latest]) throw new Error(`${pkg.name}: metadata for ${latest} missing on ${registry}`);
    metadata = candidate;
    break;
  } catch (error) {
    if (attempt === attempts) throw error;
    console.warn(`${error.message}; retry ${attempt}/${attempts - 1} in 30s`);
    await setTimeout(30_000);
  }
}
const latest = metadata['dist-tags'].latest;
const version = metadata.versions[latest];

// 不包含执行时间；同一正式版本重复运行不会产生空提交。
const dump = {
  name: pkg.name,
  latest,
  publishedAt: metadata.time?.[latest] ?? null,
  dist: {
    tarball: version.dist?.tarball ?? null,
    integrity: version.dist?.integrity ?? null,
    unpackedSize: version.dist?.unpackedSize ?? null,
  },
};
writeFileSync(new URL('../npm-latest.json', import.meta.url), `${JSON.stringify(dump, null, 2)}\n`);
console.log(`npm-latest.json: ${pkg.name}@${latest} (published ${dump.publishedAt})`);
