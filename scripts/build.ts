import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const all = process.argv.includes('--all');
const targets = all ? (['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64'] as const) : [null];
for (const target of targets) {
  const outfile = target ? `dist/tiness-${target.replace('bun-', '')}` : 'dist/tiness';
  const result = await Bun.build({
    entrypoints: ['./src/cli.ts'], minify: true,
    compile: { ...(target ? { target: target as `bun-${"darwin" | "linux"}-${"arm64" | "x64"}` } : {}), outfile, autoloadDotenv: false, autoloadBunfig: false, autoloadPackageJson: false, autoloadTsconfig: false },
  });
  if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
  console.log(`Built ${outfile}`);
}
