import { readFileSync, writeFileSync } from 'node:fs';

// 与其他 DSH 插件保持一致：正式版发布后将 registry 的 latest 元数据回写仓库。
const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}`, {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Registry request failed: ${response.status} ${response.statusText} (${registry})`);
}
const metadata = await response.json();
const latest = metadata['dist-tags']?.latest;
if (!latest) throw new Error(`${pkg.name}: no latest dist-tag on ${registry}`);
const version = metadata.versions?.[latest];
if (!version) throw new Error(`${pkg.name}: metadata for ${latest} missing on ${registry}`);

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
