import L from 'leaflet';
import type { PublicConfig } from '@/lib/config/publicConfig';
import type { BaseLayerCategory, BaseLayerInfo } from '@/lib/map/IMapEngine';

export interface LeafletBaseLayer extends BaseLayerInfo {
  create(): L.TileLayer;
}

/** Tile sources available to the Leaflet engine. */
export class BaseLayerCatalog {
  private readonly layers: LeafletBaseLayer[];

  constructor(config: PublicConfig) {
    this.layers = [
      {
        id: 'osm',
        label: 'Street (OpenStreetMap)',
        category: 'street',
        crs: 'EPSG:3857',
        attribution: '&copy; OpenStreetMap contributors',
        create: () =>
          L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            crossOrigin: true,
          }),
      },
      {
        id: 'esri-imagery',
        label: 'Satellite (Esri World Imagery)',
        category: 'satellite',
        crs: 'EPSG:3857',
        create: () =>
          L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            maxNativeZoom: 18,
            attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, GIS User Community',
            crossOrigin: true,
          }),
      },
    ];
    const ortho = config.govmapOrtho;
    if (ortho) {
      this.layers.push({
        id: 'govmap-ortho',
        label: 'Aerial photo (govmap תצ"א, ITM)',
        category: 'satellite',
        crs: 'EPSG:2039',
        note: 'Displayed in the Israeli TM grid (EPSG:2039); switching to it re-projects the map. Tile grid is configurable and unverified.',
        create: () =>
          L.tileLayer(ortho.urlTemplate, {
            maxZoom: ortho.resolutions.length - 1,
            minZoom: 0,
            attribution: 'Orthophoto &copy; <a href="https://www.govmap.gov.il">govmap.gov.il</a>',
            // The dev tile stub and most ArcGIS caches have no tiles outside Israel.
            errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
          }),
      });
    }
  }

  list(): LeafletBaseLayer[] {
    return this.layers;
  }

  get(id: string): LeafletBaseLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  defaultFor(category: BaseLayerCategory): LeafletBaseLayer {
    return this.layers.find((l) => l.category === category) ?? this.layers[0]!;
  }
}
