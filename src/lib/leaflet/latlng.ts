import L from 'leaflet';
import type { LngLat } from '@/lib/geo/types';

/** GeoJSON order ([lng, lat]) ↔ Leaflet order (lat, lng). Keep all swaps in one place. */
export const toLatLng = ([lng, lat]: LngLat): L.LatLng => L.latLng(lat, lng);
export const toLngLat = (ll: L.LatLng): LngLat => [ll.lng, ll.lat];

/** Leaflet tooltips/popups take HTML strings: user-provided text must be escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
