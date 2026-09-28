// Downloads the Apollo 11 surface photographs the model is trained on: Hasselblad magazine 40
// (the colour magazine used on the moonwalk), frames AS11-40-5844 to 5969, as scanned for the
// Apollo Lunar Surface Journal. They go into reference/photos, which is git-ignored.
// Usage: node tools/fetch-photos.mjs
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'reference', 'photos');
await mkdir(dir, { recursive: true });

let got = 0;
for (let frame = 5844; frame <= 5969; frame++) {
  const name = `AS11-40-${frame}HR.jpg`, file = join(dir, name);
  try {
    await access(file);
    got++;
    continue;
  } catch {
    // not downloaded yet
  }
  const res = await fetch(`https://apollojournals.org/alsj/a11/${name}`);
  if (!res.ok) {
    console.warn(`${name}: ${res.status} ${res.statusText}`);
    continue;
  }
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  got++;
  console.log(`got ${name}`);
}
console.log(`${got} photographs in ${dir}`);
