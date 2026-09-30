/**
 * govmap constants that could NOT be verified against the live API from the
 * development sandbox (govmap.gov.il was unreachable). They are isolated here so
 * they can be corrected in one place; see README › "govmap: things to verify".
 */

/**
 * Ground resolution (m/px) of govmap zoom levels 0..11, derived from the standard
 * Israeli scale ladder at 96 dpi (1:3,000,000 … 1:500). Used to translate an
 * engine-neutral resolution into a govmap `level`, and as the default tile grid
 * for govmap orthophoto tiles in Leaflet.
 */
export const GOVMAP_LEVEL_RESOLUTIONS = [
  793.751587503175, 264.583862501058, 132.291931250529, 66.1459656252646, 26.4583862501058, 13.2291931250529,
  6.61459656252646, 2.64583862501058, 1.32291931250529, 0.661459656252646, 0.264583862501058, 0.132291931250529,
] as const;

/** Top-left origin (ITM metres) of the govmap tile grid. Unverified default; override with GOVMAP_ORTHO_ORIGIN. */
export const GOVMAP_TILE_ORIGIN: [number, number] = [-5403900, 7116700];

/**
 * govmap background ids for `setBackground`. Unverified: 0 is the default street
 * map; the orthophoto (תצ"א) id is believed to be 1 on current deployments.
 */
export const GOVMAP_BACKGROUNDS = {
  street: 0,
  orthophoto: 1,
} as const;
