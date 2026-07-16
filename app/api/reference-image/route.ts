import fs from 'node:fs/promises';
import path from 'node:path';
import { IMAGES_DIR } from '@/lib/reference/prepare';

export const dynamic = 'force-dynamic';

/* Serves reference images to the UI thumbnail strip, and (in MOCK_MODE)
 * doubles as the "listing image CDN": the `distort` param applies controlled
 * edits so mock pHash distances behave like real-world copies vs unrelated
 * photos. distort=none → near-exact copy; slight → recompressed/resized copy
 * (small Hamming distance); heavy → hue-rotated + flipped (large distance). */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const i = parseInt(url.searchParams.get('i') ?? '0', 10);
  const distort = url.searchParams.get('distort') ?? 'original';

  let files: string[] = [];
  try {
    files = (await fs.readdir(IMAGES_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  } catch {
    return new Response('no reference images', { status: 404 });
  }
  const file = files[i % Math.max(files.length, 1)];
  if (!file) return new Response('no reference images', { status: 404 });

  const buf = await fs.readFile(path.join(IMAGES_DIR, file));

  if (distort === 'original' || distort === 'none') {
    return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'image/jpeg' } });
  }

  try {
    const sharp = (await import('sharp')).default;
    let img = sharp(buf);
    if (distort === 'slight') {
      img = img.resize(360).jpeg({ quality: 55 });
    } else {
      img = img.flop().modulate({ hue: 180, brightness: 1.15 }).resize(300).jpeg({ quality: 70 });
    }
    const out = await img.toBuffer();
    return new Response(new Uint8Array(out), { headers: { 'Content-Type': 'image/jpeg' } });
  } catch {
    return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'image/jpeg' } });
  }
}
