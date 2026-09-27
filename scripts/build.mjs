// Validates the extension and packages it. No dependencies.
//   node scripts/build.mjs          -> check + dist/x-spaces-probe/ + dist/x-spaces-probe-<version>.zip
//   node scripts/build.mjs --check  -> check only
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension');
const dist = join(root, 'dist');
const checkOnly = process.argv.includes('--check');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
for (const perm of ['tabCapture', 'offscreen']) {
  if (!manifest.permissions.includes(perm)) fail(`missing permission ${perm}`);
}

const referenced = [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((c) => c.js),
  'offscreen.html',
  'offscreen.js',
];
for (const f of referenced) if (!existsSync(join(src, f))) fail(`missing file extension/${f}`);

for (const f of readdirSync(src).filter((f) => f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', join(src, f)], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax error in ${f}\n${r.stderr}`);
}
console.log(`✓ extension/ ok (v${manifest.version})`);
if (checkOnly) process.exit(0);

const out = join(dist, 'x-spaces-probe');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(src, out, { recursive: true });
console.log(`✓ copied to ${out}`);

const zipName = `x-spaces-probe-${manifest.version}.zip`;
const z = spawnSync('zip', ['-qr', join('..', zipName), '.'], { cwd: out, encoding: 'utf8' });
if (z.error || z.status !== 0) console.log('! `zip` not available; skipped zip (load the folder unpacked instead)');
else console.log(`✓ dist/${zipName}`);
