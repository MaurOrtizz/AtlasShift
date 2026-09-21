import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

export interface CountryData {
  name: string;
  color: string;
  geometry?: Geometry | null;
  properties?: GeoJsonProperties;
}

export type BackgroundBounds = [[number, number], [number, number], [number, number], [number, number]];

export interface WorldData {
  id?: number;
  name: string;
  edits: Record<string, CountryData>;
  schema_version?: 0 | 1;
  base_map?: FeatureCollection | null;
  background_image?: string | null;
  background_bounds?: BackgroundBounds | null;
  allow_overlapping?: boolean;
}

export type ProjectState = Required<Pick<WorldData,
  'edits' | 'base_map' | 'background_image' | 'background_bounds' | 'allow_overlapping'
>>;

export function worldPayload(name: string, state: ProjectState): WorldData {
  // Missing geometry means unchanged; explicit null means deleted. Never coalesce them.
  return { ...state, name, schema_version: 1 };
}

export function projectChanged(current: ProjectState, saved: ProjectState): boolean {
  return (Object.keys(current) as (keyof ProjectState)[]).some(key => current[key] !== saved[key]);
}

export function normalizeBaseMap(input: unknown): FeatureCollection {
  if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'FeatureCollection' ||
      !('features' in input) || !Array.isArray(input.features)) {
    throw new Error('Expected a GeoJSON FeatureCollection.');
  }
  const names = new Set<string>();
  const features = input.features.map((feature, index) => {
    const geometry = feature?.geometry;
    if (feature?.type !== 'Feature' || !geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
      throw new Error(`Feature ${index + 1} must have a Polygon or MultiPolygon geometry.`);
    }
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length || polygons.some((polygon: unknown) =>
      !Array.isArray(polygon) || !polygon.length || polygon.some((ring: unknown) =>
        !Array.isArray(ring) || ring.length < 4 || ring.some((point: unknown) =>
          !Array.isArray(point) || point.length < 2 || !point.every(value => typeof value === 'number' && Number.isFinite(value))) ||
        JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1])
      ))) {
      throw new Error(`Feature ${index + 1} contains invalid or unclosed polygon coordinates.`);
    }
    const name = feature.properties?.name ?? `country-${index + 1}`;
    if (typeof name !== 'string' || !name.trim() || names.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new Error('Every feature must have a unique, non-empty name.');
    }
    names.add(name);
    return { ...feature, properties: { ...feature.properties, name } };
  });
  return { ...input, type: 'FeatureCollection', features } as FeatureCollection;
}

export function exportMap(base: FeatureCollection, edits: Record<string, CountryData>): FeatureCollection {
  const seen = new Set<string>();
  const features = base.features.flatMap(feature => {
    const key = feature.properties?.name;
    seen.add(key);
    const edit = edits[key];
    if (edit?.geometry === null) return [];
    return [{ ...feature, geometry: edit?.geometry ?? feature.geometry, properties: {
      ...feature.properties, ...edit?.properties,
      name: edit?.name ?? key,
      customColor: edit?.color ?? feature.properties?.customColor ?? '#dcdcdc',
    } }];
  });
  for (const [key, edit] of Object.entries(edits)) {
    if (seen.has(key) || !edit.geometry) continue;
    features.push({ type: 'Feature', geometry: edit.geometry, properties: {
      ...edit.properties, name: edit.name, customColor: edit.color,
    } });
  }
  return { ...base, features };
}

export function restoreWorld(world: WorldData, defaultMap: FeatureCollection): ProjectState {
  if (world.schema_version !== undefined && world.schema_version !== 0 && world.schema_version !== 1) {
    throw new Error('This world was created with an unsupported project version.');
  }
  if (world.schema_version === 1 && !world.base_map) {
    throw new Error('This world is missing its base map.');
  }
  return {
    edits: world.edits,
    base_map: world.base_map ?? defaultMap,
    background_image: world.background_image ?? null,
    background_bounds: world.background_bounds ?? null,
    allow_overlapping: world.allow_overlapping ?? false,
  };
}

export async function confirmReplacement(
  dirty: boolean,
  confirm: (message: string) => boolean,
  save: () => Promise<boolean>,
): Promise<boolean> {
  if (!dirty) return true;
  if (confirm('You have unsaved changes. Save before continuing?')) return save();
  return confirm('Discard unsaved changes and continue anyway?');
}
