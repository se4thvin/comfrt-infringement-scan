import fs from 'node:fs/promises';
import path from 'node:path';
import { phashFromBuffer, type PHash } from '../scoring/signals/imageHash';

export interface ReferenceSet {
  /** hashed reference images; empty ⇒ image signal disabled */
  hashes: { name: string; hash: PHash }[];
  warning?: string;
}

export const IMAGES_DIR = path.join(process.cwd(), 'lib', 'reference', 'images');

let cached: ReferenceSet | null = null;

/** Load reference images from disk and pHash them. Cached per process —
 *  reference images don't change between jobs. */
export async function prepareReferenceSet(mock: boolean): Promise<ReferenceSet> {
  if (cached) return cached;

  let files: string[] = [];
  try {
    files = (await fs.readdir(IMAGES_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  } catch {
    /* dir missing */
  }

  if (files.length === 0 && mock) {
    await generateSyntheticReference();
    files = (await fs.readdir(IMAGES_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  }

  if (files.length === 0) {
    cached = {
      hashes: [],
      warning:
        'No reference images found. Run `npm run fetch-reference` first — scoring will use text signals only.',
    };
    return cached;
  }

  const hashes: ReferenceSet['hashes'] = [];
  for (const f of files.sort()) {
    const buf = await fs.readFile(path.join(IMAGES_DIR, f));
    const hash = await phashFromBuffer(buf);
    if (hash !== null) hashes.push({ name: f, hash });
  }

  cached = {
    hashes,
    warning:
      hashes.length === 0
        ? 'Reference images exist but could not be hashed (sharp unavailable?) — text signals only.'
        : undefined,
  };
  return cached;
}

/** MOCK_MODE only: create 8 visually-distinct synthetic images so the image
 *  pipeline is exercisable without network access to comfrt.com. */
async function generateSyntheticReference(): Promise<void> {
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    return;
  }
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  for (let i = 0; i < 8; i++) {
    // Distinct hue + a geometric figure per image → well-separated pHashes.
    const hue = (i * 45) % 360;
    const svg = `<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
      <rect width="400" height="400" fill="hsl(${hue},60%,80%)"/>
      <circle cx="${100 + i * 25}" cy="200" r="${60 + i * 10}" fill="hsl(${(hue + 180) % 360},70%,40%)"/>
      <rect x="${40 + i * 30}" y="${40 + i * 15}" width="120" height="${60 + i * 20}" fill="hsl(${(hue + 90) % 360},50%,30%)"/>
      <text x="30" y="380" font-size="40" font-family="sans-serif">MOCK REF ${i}</text>
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(path.join(IMAGES_DIR, `mock-ref-${i}.jpg`));
  }
  console.log('[reference] generated 8 synthetic mock reference images');
}
