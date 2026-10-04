/** Shared types of the fonts module. */

/** A font family shipped with the app (from an @fontsource package). */
export interface BundledFamily {
  pkg: string;
  family: string;
  /** Normal-style weights that are bundled. */
  weights: number[];
  /** Italic faces bundled (same weights). */
  italic: boolean;
  /** CJK family split into unicode-range chunks (manifest loaded lazily). */
  japanese: boolean;
}
