// Units: feet, kips.

export interface Point {
  x: number;
  y: number;
}

/** Floor slab: outer boundary plus voids (courtyards, shafts) that carry no mass. */
export interface Outline {
  outer: Point[];
  holes: Point[][];
}

export type Direction = 'X' | 'Y';
export type Fixity = 'cantilever' | 'fixed';

/** Rectangular concrete wall segment, defined by its centerline. Must be orthogonal. */
export interface Wall {
  id: string;
  start: Point;
  end: Point;
  /** Thickness, ft. */
  t: number;
}

export interface BuildingSettings {
  stories: number;
  /** Typical story height, ft. */
  storyHeight: number;
  /** Default wall thickness, ft. */
  wallThickness: number;
  fixity: Fixity;
  minWallsPerDirection: number;
  /** Seismic dead load, psf (uniform). */
  seismicPsf: number;
  /** Accidental eccentricity ratio, ASCE 7 §12.8.4.2. */
  accidentalRatio: number;
}

export const DEFAULT_SETTINGS: BuildingSettings = {
  stories: 9,
  storyHeight: 10,
  wallThickness: 1.5,
  fixity: 'cantilever',
  minWallsPerDirection: 2,
  seismicPsf: 50,
  accidentalRatio: 0.05,
};
