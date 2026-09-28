// Downloads the Apollo 11 HD clips from NASA's Image and Video Library into reference/, as
// modelling reference. The folder is git-ignored and isn't part of the site.
// Usage: node tools/fetch-reference.mjs
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The clips listed on https://www.nasa.gov/history/apollo-11-hd-videos/
const IDS = [
  'Apollo_11_moonwalk_montage_720p',
  'One_Small_Step_Comparison_720p',
  'Buzz_Descends_Comparison__720p',
  'Apollo_11_Plaque_Comparison_720p',
  'Raising_The_American_Flag_Comparison_720p',
  'Apollo_11_Intro_720p',
];

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'reference');
await mkdir(dir, { recursive: true });

for (const id of IDS) {
  const file = join(dir, `${id}.mov`);
  try {
    await access(file);
    console.log(`have ${id}`);
    continue;
  } catch {
    // not downloaded yet
  }
  const res = await fetch(`https://images-assets.nasa.gov/video/${id}/${id}~orig.mov`);
  if (!res.ok) {
    console.warn(`${id}: ${res.status} ${res.statusText}`);
    continue;
  }
  const body = Buffer.from(await res.arrayBuffer());
  await writeFile(file, body);
  console.log(`got ${id} (${(body.length / 1048576).toFixed(1)} MB)`);
}
