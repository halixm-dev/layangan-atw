// Menjalankan Blender headless untuk membuat semua aset .glb
// Set env BLENDER_PATH jika blender tidak ada di lokasi default.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.BLENDER_PATH,
  'E:\\5. Programs\\4. Blender\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
  '/Applications/Blender.app/Contents/MacOS/Blender',
  'blender',
].filter(Boolean);

const blender = candidates.find((p) => p === 'blender' || existsSync(p));
const script = path.join(root, 'blender', 'build_assets.py');
const out = path.join(root, 'public', 'assets');

console.log(`[assets] Blender: ${blender}`);
const res = spawnSync(blender, ['-b', '--factory-startup', '-P', script, '--', out], { stdio: 'inherit' });
process.exit(res.status ?? 1);
