// Runs the test suite: the WebAssembly sort check, then the capture-importer round trips and the
// SPZ encoder check (bundled for Node with esbuild). Usage: npm run build && npm test
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (file) => execFileSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });

run(join(root, 'tools/sort-check.mjs'));

for (const name of ['importers', 'spz-encoder']) {
  const out = join(root, `dist-test/${name}.test.mjs`);
  await build({
    absWorkingDir: root,
    entryPoints: [`tests/${name}.test.ts`],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: out,
    logLevel: 'warning',
  });
  run(out);
}
