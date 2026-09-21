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
  schema_version?: 0 | 1 | 2;
  base_map?: FeatureCollection | null;
  background_image?: string | null;
  background_bounds?: BackgroundBounds | null;
  allow_overlapping?: boolean;
}

export type ProjectState = Required<Pick<WorldData,
  'edits' | 'base_map' | 'background_image' | 'background_bounds' | 'allow_overlapping'
>>;

export function worldPayload(name: string, state: ProjectState): WorldData {
  if (Object.values(state.edits).some(edit => typeof edit.name !== 'string' || !edit.name.trim())) {
    throw new Error('Every country needs a non-empty name before saving.');
  }
  // Missing geometry means unchanged; explicit null means deleted. Never coalesce them.
  return { ...state, name, schema_version: 2 };
}

export function projectChanged(current: ProjectState, saved: ProjectState): boolean {
  return (Object.keys(current) as (keyof ProjectState)[]).some(key => current[key] !== saved[key]);
}

export function validTerritoryId(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0 && id !== 'prototype' && !Object.hasOwn(Object.prototype, id);
}

// Normalize IDs once at the import boundary. Names are labels, never identity.
export function normalizeBaseMap(input: unknown, requireIds = false): FeatureCollection {
  if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'FeatureCollection' ||
      !('features' in input) || !Array.isArray(input.features)) {
    throw new Error('Expected a GeoJSON FeatureCollection.');
  }
  const ids = new Set<string>();
  for (const feature of input.features) {
    if (feature?.id === undefined && !requireIds) continue;
    const id = typeof feature?.id === 'number' && Number.isFinite(feature.id) ? String(feature.id) : feature?.id;
    if (!validTerritoryId(id) || ids.has(id)) throw new Error('Every feature ID must be unique and non-empty.');
    ids.add(id);
  }
  let nextId = 1;
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
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('Every feature must have a non-empty name.');
    }
    let id = feature.id === undefined ? undefined : String(feature.id);
    if (id === undefined) {
      while (ids.has(`territory-${nextId}`)) nextId++;
      id = `territory-${nextId++}`;
      ids.add(id);
    }
    return { ...feature, id, properties: { ...feature.properties, name } };
  });
  return { ...input, type: 'FeatureCollection', features } as FeatureCollection;
}

// Old bundled maps contain exact duplicate countries. Preserve distinct same-name
// features (including the two Ocean masks), and features with explicit IDs.
export function normalizeLegacyMap(base: FeatureCollection): FeatureCollection {
  const seen = new Set<string>();
  return normalizeBaseMap({ ...base, features: base.features.filter(feature => {
    if (feature.id !== undefined) return true;
    const signature = JSON.stringify(feature);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  }) });
}

export function exportMap(base: FeatureCollection, edits: Record<string, CountryData>): FeatureCollection {
  const seen = new Set<string>();
  const features = base.features.flatMap(feature => {
    const key = String(feature.id);
    seen.add(key);
    const edit = edits[key];
    if (edit?.geometry === null) return [];
    return [{ ...feature, geometry: edit?.geometry ?? feature.geometry, properties: {
      ...feature.properties, ...edit?.properties,
      name: edit?.name ?? feature.properties?.name,
      customColor: edit?.color ?? feature.properties?.customColor ?? '#dcdcdc',
    } }];
  });
  for (const [key, edit] of Object.entries(edits)) {
    if (seen.has(key) || !edit.geometry) continue;
    features.push({ type: 'Feature', id: key, geometry: edit.geometry, properties: {
      ...edit.properties, name: edit.name, customColor: edit.color,
    } });
  }
  return { ...base, features };
}

export function restoreWorld(world: WorldData, defaultMap: FeatureCollection): ProjectState {
  if (world.schema_version !== undefined && ![0, 1, 2].includes(world.schema_version)) {
    throw new Error('This world was created with an unsupported project version.');
  }
  if ((world.schema_version === 1 || world.schema_version === 2) && !world.base_map) {
    throw new Error('This world is missing its base map.');
  }
  const legacy = world.schema_version !== 2;
  const base = legacy ? normalizeLegacyMap(world.base_map ?? defaultMap) : normalizeBaseMap(world.base_map, true);
  if (!world.edits || typeof world.edits !== 'object' || Array.isArray(world.edits)) {
    throw new Error('This world has invalid territory edits.');
  }
  const edits: Record<string, CountryData> = {};
  const baseIds = new Set(base.features.map(feature => String(feature.id)));
  const usedIds = new Set(baseIds);
  const legacyIds = new Map<string, string[]>();
  for (const feature of base.features) {
    const name = feature.properties?.name as string;
    legacyIds.set(name, [...legacyIds.get(name) ?? [], String(feature.id)]);
  }
  let nextId = 1;
  for (const [key, edit] of Object.entries(world.edits)) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('Invalid territory edit.');
    if (!legacy && (!validTerritoryId(key) || typeof edit.name !== 'string' || !edit.name.trim() || typeof edit.color !== 'string')) {
      throw new Error('Invalid territory ID, name, or color.');
    }
    let ids = legacy ? legacyIds.get(key) : [key];
    if (!ids) {
      while (usedIds.has(`legacy-${nextId}`)) nextId++;
      ids = [`legacy-${nextId++}`];
      usedIds.add(ids[0]);
    }
    for (const id of ids) {
      edits[id] = legacy ? { ...edit, name: edit.name || key, color: edit.color || '#dcdcdc' } : edit;
    }
  }
  // Validate committed geometries without confusing absent geometry with deletion.
  normalizeBaseMap(exportMap(base, edits), true);
  for (const [id, edit] of Object.entries(edits)) {
    if (!baseIds.has(id) && edit.geometry === undefined) throw new Error('A new territory is missing its geometry.');
  }
  return {
    edits,
    base_map: base,
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
