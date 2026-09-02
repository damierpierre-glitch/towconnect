// What a browser actually downloads, measured from the production build.
//
//   npm run build && npm run measure:bundles
//
// WHY THIS EXISTS
// Next 16 with Turbopack no longer prints per-route sizes at the end of a
// build, and a performance claim without a number is not a claim. This reads
// the build manifest for the files EVERY route loads, then lists the largest
// chunks on disk so an expensive dependency is visible by name rather than
// suspected.
//
// Sizes are gzipped, because that is what crosses the wire. Uncompressed
// bytes make every bundle look twice as bad as it is, and the point of
// measuring is to decide what to fix.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, relative } from 'node:path';

const NEXT = join(process.cwd(), '.next');
const MANIFEST = join(NEXT, 'build-manifest.json');

if (!existsSync(MANIFEST)) {
  console.error('No build-manifest.json. Run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  polyfillFiles?: string[];
  lowPriorityFiles?: string[];
  rootMainFiles?: string[];
};

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;

function gz(path: string): number {
  if (!existsSync(path)) return 0;
  const buf = readFileSync(path);
  return path.endsWith('.js') || path.endsWith('.css') ? gzipSync(buf).length : buf.length;
}

const shared = [
  ...(manifest.rootMainFiles ?? []),
  ...(manifest.polyfillFiles ?? []),
  ...(manifest.lowPriorityFiles ?? []),
];
const sharedBytes = shared.reduce((sum, f) => sum + gz(join(NEXT, f)), 0);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

const staticDir = join(NEXT, 'static');
const assets = walk(staticDir)
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => ({ file: relative(staticDir, f), bytes: gz(f), raw: statSync(f).size }))
  .sort((a, b) => b.bytes - a.bytes);

const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);

console.log('\nProduction client assets, gzipped.\n');
console.log(`  Loaded by every route (root + polyfills + CSS): ${kb(sharedBytes)}`);
console.log(`  All client chunks on disk:                      ${kb(totalBytes)} across ${assets.length} files\n`);
console.log('  Ten largest chunks — a heavy dependency shows up here by name:\n');
for (const a of assets.slice(0, 10)) {
  console.log(`    ${kb(a.bytes).padStart(9)}  ${a.file}`);
}

// Images are downloaded too, and a 230 kB logo costs more than a route split.
const publicDir = join(process.cwd(), 'public');
const appDir = join(process.cwd(), 'src', 'app');
const images = [...walk(publicDir), ...walk(appDir)]
  .filter((f) => /\.(png|jpe?g|svg|webp|avif)$/i.test(f))
  .map((f) => ({ file: relative(process.cwd(), f), bytes: statSync(f).size }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 8);

if (images.length) {
  console.log('\n  Largest images (raw bytes — these are not gzipped in transit):\n');
  for (const i of images) {
    console.log(`    ${kb(i.bytes).padStart(9)}  ${i.file}`);
  }
}
console.log('');
