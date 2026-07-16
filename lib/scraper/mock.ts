import type { SearchPageRequest } from './client';

/* MOCK_MODE fixtures. Deliberately include the archetypes the scorer must
 * separate: near-exact brand copies, misspelled-brand knockoffs, generic
 * "comfy hoodie" items, unrelated products caught by the query, and (on
 * mock-eBay) auctions that should get a down-weighted price signal.
 *
 * Image URLs point at the app's own /reference-images route with a `distort`
 * param, so mock pHash distances behave like the real world: copies hash
 * close to reference images, unrelated items hash far. */

interface MockItem {
  title: string;
  price: number;
  img?: string; // path under /api/reference-image?i=N&distort=D
  auction?: boolean;
}

const AMAZON_POOL: MockItem[] = [
  { title: 'Comfrt Cloud Hoodie Oversized Unisex Fleece - Cream', price: 24.99, img: '0:none' },
  { title: 'COMFRT Signature Hoodie Premium Soft Sweatshirt Anxiety Relief', price: 19.95, img: '1:slight' },
  { title: 'Cømfrt Style Oversized Hoodie Cloud Feel Plush', price: 15.99, img: '2:slight' },
  { title: 'Oversized Hoodie for Women Comfy Cloud Fleece Pullover', price: 27.5, img: '3:heavy' },
  { title: 'Comfrt Hoodie Dupe Viral TikTok Oversized Sweatshirt', price: 13.49, img: '0:slight' },
  { title: 'Hanes Mens Pullover EcoSmart Hooded Sweatshirt', price: 16.2 },
  { title: 'Comfrt Cloud Half Zip Cropped Sweatshirt Womens', price: 22.0, img: '4:none' },
  { title: 'Weighted Blanket Hoodie Wearable Oversized Sherpa', price: 34.99, img: '5:heavy' },
  { title: 'USB C Charging Cable 6ft Braided 2-Pack', price: 8.99 },
  { title: 'Comfrt Official Cloud Sweatpants Matching Set', price: 29.99, img: '6:slight' },
  { title: 'Gildan Adult Fleece Hoodie Multipack', price: 21.0 },
  { title: 'C0MFRT Oversized Hoodie Cloud Soft Anti Anxiety Sweatshirt', price: 11.99, img: '1:none' },
];

const EBAY_POOL: MockItem[] = [
  { title: 'Comfrt Cloud Hoodie Size L Cream NEW WITH TAGS', price: 18.0, img: '0:slight', auction: true },
  { title: 'NWT Comfrt Signature Hoodie Lavender Oversized', price: 25.0, img: '2:none' },
  { title: 'comfrt hoodie replica high quality same factory', price: 9.99, img: '3:slight' },
  { title: 'Vintage Champion Reverse Weave Hoodie XL', price: 32.0, auction: true },
  { title: 'Comfrt Cloud Blanket Hoodie Bundle x2 Wholesale', price: 21.5, img: '4:slight' },
  { title: 'Oversized comfy cloud hoodie unbranded bulk lot 10pcs', price: 45.0, img: '5:heavy' },
  { title: 'COMFRT hoodie - authentic? see photos', price: 14.0, img: '6:heavy', auction: true },
  { title: 'Nike Tech Fleece Hoodie Grey Medium', price: 40.0 },
  { title: 'Comfrt style hoodie custom logo accepted OEM', price: 7.5, img: '7:slight' },
];

export function mockSearchResponse(req: SearchPageRequest): unknown {
  const pool = req.platform === 'amazon' ? AMAZON_POOL : EBAY_POOL;
  // Rotate the pool by query+page so different queries surface overlapping
  // subsets — exercises dedupe exactly like real repeated ASINs do.
  const offset = (hashStr(req.query) + (req.page - 1) * 3) % pool.length;
  const slice = [...pool.slice(offset), ...pool.slice(0, offset)].slice(0, 6);

  const items = slice.map((m, i) => {
    const idNum = 100000 + (hashStr(m.title) % 90000);
    const [refIdx, distort] = (m.img ?? ':').split(':');
    const image = m.img
      ? `http://localhost:${process.env.PORT ?? 3000}/api/reference-image?i=${refIdx}&distort=${distort}`
      : undefined;
    if (req.platform === 'amazon') {
      return {
        asin: `B0MOCK${idNum}`,
        name: m.title,
        price: m.price,
        price_string: `$${m.price.toFixed(2)}`,
        image,
        url: `https://www.amazon.com/dp/B0MOCK${idNum}`,
        position: i + 1,
      };
    }
    return {
      id: String(200000000000 + idNum),
      title: m.title,
      price: `$${m.price.toFixed(2)}`,
      image,
      url: `https://www.ebay.com/itm/${200000000000 + idNum}`,
      listing_type: m.auction ? 'auction' : 'fixed_price',
    };
  });

  return { results: items };
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
