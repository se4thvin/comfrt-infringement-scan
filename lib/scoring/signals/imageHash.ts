/* pHash: resize to 32x32 grayscale → 2D DCT → 8x8 low-frequency block →
 * threshold on median → 64-bit hash. Robust to resize/recompression, which is
 * exactly how counterfeiters reuse stolen product photos.
 *
 * sharp is a native module. If it fails to load (unusual platform), the image
 * signal reports itself unavailable and the pipeline continues on text
 * signals — graceful degradation applies to our own dependencies too. */

let sharpMod: typeof import('sharp') | null | undefined;

async function getSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch (e) {
    console.error('[imageHash] sharp failed to load — image signal disabled:', e);
    sharpMod = null;
  }
  return sharpMod;
}

const N = 32; // input size
const K = 8;  // low-frequency block

export type PHash = bigint;

export async function phashFromBuffer(buf: Buffer): Promise<PHash | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const raw = await sharp(buf)
      .resize(N, N, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    const dct = dct2d(raw);
    // 8x8 low-frequency block, excluding the DC term at [0][0]
    const vals: number[] = [];
    for (let y = 0; y < K; y++)
      for (let x = 0; x < K; x++)
        if (x !== 0 || y !== 0) vals.push(dct[y * N + x]);

    const median = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    let hash = 0n;
    for (let i = 0; i < vals.length; i++) {
      hash <<= 1n;
      if (vals[i] > median) hash |= 1n;
    }
    return hash;
  } catch (e) {
    console.warn('[imageHash] failed to hash image:', (e as Error).message);
    return null;
  }
}

export function hamming(a: PHash, b: PHash): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Naive separable 2D DCT-II on an N×N grayscale buffer. N=32 → trivial cost
 *  relative to the network I/O around it. */
function dct2d(pixels: Buffer): Float64Array {
  const f = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = pixels[i];

  const tmp = new Float64Array(N * N);
  const cosTable: number[][] = [];
  for (let u = 0; u < N; u++) {
    cosTable[u] = [];
    for (let x = 0; x < N; x++) {
      cosTable[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }
  // rows
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += f[y * N + x] * cosTable[u][x];
      tmp[y * N + u] = s;
    }
  }
  // cols
  const out = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += tmp[y * N + u] * cosTable[v][y];
      out[v * N + u] = s;
    }
  }
  return out;
}
