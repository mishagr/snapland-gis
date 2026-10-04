import { getPublicConfig } from '@/server/config/publicConfig';

export const dynamic = 'force-dynamic';

/**
 * Development-only stand-in for govmap orthophoto tiles: an SVG per tile of the
 * configured EPSG:2039 grid, labelled with its z/x/y and ITM coordinates. It makes
 * the Leaflet CRS switch visible and testable without access to govmap's tile
 * service. Enabled only when ENABLE_DEV_TILES=true.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  if (process.env.ENABLE_DEV_TILES !== 'true') return new Response('Not found', { status: 404 });
  const { z, x, y } = await ctx.params;
  const [zi, xi, yi] = [z, x, y].map((v) => Number.parseInt(v, 10));
  const grid = getPublicConfig().govmapOrtho;
  if (!grid || [zi, xi, yi].some((n) => !Number.isInteger(n)) || zi! < 0 || zi! >= grid.resolutions.length) {
    return new Response('Not found', { status: 404 });
  }
  const res = grid.resolutions[zi!]!;
  const left = grid.origin[0] + xi! * 256 * res;
  const top = grid.origin[1] - yi! * 256 * res;
  // Checkerboard tint so tile boundaries (and therefore grid alignment) are obvious.
  const tint = (xi! + yi!) % 2 === 0 ? '#dfe9d8' : '#d3e0ca';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="${tint}"/>
  <path d="M0 0H256V256" fill="none" stroke="#7a8f6c" stroke-width="1"/>
  <path d="M128 0V256M0 128H256" stroke="#9fb392" stroke-dasharray="3 5"/>
  <text x="8" y="18" font-family="monospace" font-size="12" fill="#3b4a31">ITM z${zi} x${xi} y${yi}</text>
  <text x="8" y="34" font-family="monospace" font-size="11" fill="#3b4a31">E ${Math.round(left)} N ${Math.round(top)}</text>
  <text x="8" y="248" font-family="monospace" font-size="10" fill="#56684a">${res.toFixed(2)} m/px · dev tile</text>
</svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' } });
}
