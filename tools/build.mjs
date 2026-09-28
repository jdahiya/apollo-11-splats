// Builds the site into dist/:
//   1. assembly/sort.ts  -> dist/sort.wasm        (AssemblyScript)
//   2. src/**/*.ts       -> dist/main.js, dist/sort-worker.js (esbuild; shaders and SVGs inlined as text)
//   3. index.html, src/styles.css and assets/ (the trained model and station photos) copied as-is
// Usage: node tools/build.mjs [--watch]
import { build, context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/assemblyscript/bin/asc.js'),
    'assembly/sort.ts',
    '--outFile', 'dist/sort.wasm',
    '--optimizeLevel', '3',
    '--shrinkLevel', '0',
    '--runtime', 'stub',
    '--noAssert',
    '--use', 'abort=',
  ],
  { cwd: root, stdio: 'inherit' },
);

const copyStatic = () =>
  Promise.all([
    cp(join(root, 'index.html'), join(dist, 'index.html')),
    cp(join(root, 'src/styles.css'), join(dist, 'styles.css')),
    cp(join(root, 'assets'), dist, { recursive: true }),
  ]);

const options = {
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts', 'sort-worker': 'src/sort/sort-worker.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: 'dist',
  minify: !watch,
  sourcemap: true,
  loader: { '.vert': 'text', '.frag': 'text', '.glsl': 'text', '.svg': 'text' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: 'copy-static', setup: (b) => b.onEnd(() => copyStatic()) }],
  });
  await ctx.watch();
  console.log('Watching for changes. Serve dist/ with: npm run serve');
} else {
  await build(options);
  await copyStatic();
}
