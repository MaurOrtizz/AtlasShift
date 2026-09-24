import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import maplibregl from 'maplibre-gl';
import MapGL, { Source, Layer } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import countriesRaw from './data/countries_mid_res.geojson?raw';
import BlankWorldMapJson from './data/BlankWorldMap.json'
import type { StyleSpecification } from 'maplibre-gl';
import { api, type WorldData, type BackgroundBounds } from './api';
import { confirmReplacement, exportMap, normalizeBaseMap, normalizeLegacyMap, projectChanged, restoreWorld, worldPayload, type CountryData, type ProjectState, type SubdivisionData } from './world';
import Navbar from './components/Navbar';
import CountryPanel from './components/CountryPanel';
import SubdivisionPanel from './components/SubdivisionPanel';
import WorldsPanel from './components/WorldsPanel';
import Sidebar from './components/Sidebar';
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon, Position } from 'geojson';

type VertexFeature = NonNullable<MapLayerMouseEvent['features']>[number];

const SEA_FEATURE_TYPE = 'sea';

function isSeaFeature(feature: Feature): boolean {
  return feature.properties?.featureType === SEA_FEATURE_TYPE;
}

function splitSeaFeatures(collection: FeatureCollection): {
  land: FeatureCollection;
  sea: Feature[];
} {
  const land: Feature[] = [];
  const sea: Feature[] = [];
  for (const feature of collection.features) {
    if (isSeaFeature(feature)) {
      sea.push(feature);
    } else {
      land.push(feature);
    }
  }
  return { land: { ...collection, features: land }, sea };
}

function clipGeometryToLand(
  geometry: Polygon | MultiPolygon,
  seaPolygons: Feature[]
): Polygon | MultiPolygon | null {
  if (seaPolygons.length === 0) return geometry;

  let current: Feature<Polygon | MultiPolygon> = {
    type: 'Feature',
    properties: {},
    geometry
  };

  for (const sea of seaPolygons) {
    if (!sea.geometry) continue;
    try {
      const result = turf.difference(
        turf.featureCollection([current, sea as Feature<Polygon | MultiPolygon>])
      );
      if (!result) return null;
      current = result;
    } catch {
      continue;
    }
  }

  return current.geometry;
}

const BlankWorldMap = BlankWorldMapJson as unknown as StyleSpecification;
const defaultCountriesDataRaw = normalizeLegacyMap(JSON.parse(countriesRaw) as FeatureCollection);
const { land: defaultCountriesData, sea: defaultSeaPolygons } = splitSeaFeatures(defaultCountriesDataRaw);
const emptyEdits: Record<string, CountryData> = {};
const emptySubdivisions: Record<string, SubdivisionData> = {};
const initialProject: ProjectState = {
  edits: emptyEdits, subdivisions: emptySubdivisions, base_map: defaultCountriesDataRaw,
  background_image: null, background_bounds: null, allow_overlapping: false,
};

function bboxesOverlap(a: number[], b: number[]) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// The incoming subdivision keeps its territory, just like a newly drawn country.
function trimSubdivisionOverlaps(existing: Record<string, SubdivisionData>, incoming: SubdivisionData) {
  const next = { ...existing };
  const incomingFeature = turf.feature(incoming.geometry as Polygon | MultiPolygon);
  const bounds = turf.bbox(incomingFeature);
  for (const [id, subdivision] of Object.entries(existing)) {
    if (subdivision.parent_id !== incoming.parent_id || !bboxesOverlap(bounds, turf.bbox(subdivision.geometry))) continue;
    const difference = turf.difference(turf.featureCollection([
      turf.feature(subdivision.geometry as Polygon | MultiPolygon), incomingFeature,
    ]));
    if (difference) next[id] = { ...subdivision, geometry: difference.geometry };
    else delete next[id];
  }
  return next;
}

function getAbsorptionCandidates(countryEdits: Record<string, CountryData>, countriesData: FeatureCollection) {
  const candidates: { name: string; geometry: Geometry }[] = [];
  const seen = new Set<string>();

  countriesData.features.forEach((feature) => {
    const name = String(feature.id);
    seen.add(name);
    if (countryEdits[name]?.geometry === null) return;
    const geometry = countryEdits[name]?.geometry ?? feature.geometry;
    if (geometry) candidates.push({ name, geometry });
  });

  Object.entries(countryEdits).forEach(([name, data]) => {
    if (seen.has(name)) return;
    if (!data.geometry) return;
    candidates.push({ name, geometry: data.geometry });
  });

  return candidates;
}

function withUpdatedRing(
  geometry: Geometry,
  polygonIndex: number,
  ringIndex: number,
  updateRing: (ring: Position[]) => Position[]
): Geometry {
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring, i) =>
        i === ringIndex ? updateRing(ring) : ring
      )
    };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((polygon, pi) =>
        pi === polygonIndex
          ? polygon.map((ring, ri) => (ri === ringIndex ? updateRing(ring) : ring))
          : polygon
      )
    };
  }
  return geometry;
}

function moveRingVertex(ring: Position[], vertexIndex: number, newCoord: Position): Position[] {
  const newRing = [...ring];
  newRing[vertexIndex] = newCoord;
  if (vertexIndex === 0) {
    newRing[newRing.length - 1] = newCoord;
  } else if (vertexIndex === newRing.length - 1) {
    newRing[0] = newCoord;
  }
  return newRing;
}

function downloadJSON(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [countriesData, setCountriesData] = useState<FeatureCollection>(defaultCountriesData);
  const [seaPolygons, setSeaPolygons] = useState<Feature[]>(defaultSeaPolygons);
  const [savedProject, setSavedProject] = useState(initialProject);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const loadRequest = useRef(0);

  const countriesById = useMemo(
    () => new Map<string, Feature>(countriesData.features.map((f) => [String(f.id), f])),
    [countriesData]
  );
  
  const [hoveredCountry, setHoveredCountry] = useState<string | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [selectedSubdivision, setSelectedSubdivision] = useState<string | null>(null);
  const [subdivisionsShownFor, setSubdivisionsShownFor] = useState<string | null>(null);
  const [countryEdits, setCountryEdits] = useState<Record<string, CountryData>>(emptyEdits);
  const [subdivisions, setSubdivisions] = useState<Record<string, SubdivisionData>>(emptySubdivisions);
  const getCountryData = useCallback((id: string): CountryData => countryEdits[id] ?? {
    name: countriesById.get(id)?.properties?.name ?? 'Unnamed country',
    color: countriesById.get(id)?.properties?.customColor ?? '#dcdcdc',
  }, [countryEdits, countriesById]);
  const [showWorldsPanel, setShowWorldsPanel] = useState(false);
  const [currentWorldId, setCurrentWorldId] = useState<number | null>(null);
  const [currentWorldName, setCurrentWorldName] = useState<string | null>(null);
  const [editingCountry, setEditingCountry] = useState<string | null>(null);
  const [allowOverlapping, setAllowOverlapping] = useState(false);
  const [editedGeometries, setEditedGeometries] = useState<Record<string, Geometry>>({});  const [editMode, setEditMode] = useState<'vertices' | 'draw' | null>(null);
  const mapRef = useRef<MapRef>(null);
  const [drawingPoints, setDrawingPoints] = useState<number[][]>([]);
  const [isAddingCountry, setIsAddingCountry] = useState(false);
  const [newCountryPoints, setNewCountryPoints] = useState<number[][]>([]);
  const [isAddingSubdivisionFor, setIsAddingSubdivisionFor] = useState<string | null>(null);
  const [newSubdivisionPoints, setNewSubdivisionPoints] = useState<number[][]>([]);
  const [draggingVertex, setDraggingVertex] = useState<{
    index: number;
    polygonIndex: number;
    ringIndex: number;
    vertexIndex: number;
    isDrawingPoint: boolean;
    isNewCountryVertex?: boolean;
  } | null>(null);
  const [absorbingCountry, setAbsorbingCountry] = useState<string | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [backgroundBounds, setBackgroundBounds] = useState<BackgroundBounds | null>(null);

  const [baseMap, setBaseMap] = useState<FeatureCollection>(defaultCountriesDataRaw);
  const project = useMemo<ProjectState>(() => ({
    edits: countryEdits, subdivisions, base_map: baseMap, background_image: backgroundImage,
    background_bounds: backgroundBounds, allow_overlapping: allowOverlapping,
  }), [countryEdits, subdivisions, baseMap, backgroundImage, backgroundBounds, allowOverlapping]);
  const committedGeometry = editingCountry
    ? countryEdits[editingCountry]?.geometry ?? countriesById.get(editingCountry)?.geometry
    : null;
  const getCountryGeometry = useCallback((id: string): Geometry | null =>
    countryEdits[id]?.geometry ?? countriesById.get(id)?.geometry ?? null,
    [countryEdits, countriesById]);
  const hasDraftChanges = (isAddingCountry && newCountryPoints.length > 0) ||
    Boolean(isAddingSubdivisionFor && newSubdivisionPoints.length > 0) ||
    Boolean(editingCountry && (
    drawingPoints.length > 0 || (editedGeometries[editingCountry] && editedGeometries[editingCountry] !== committedGeometry)
  ));
  const hasUnsavedChanges = projectChanged(project, savedProject) || hasDraftChanges;
  const revision = useMemo(() => ({ project, editedGeometries, drawingPoints, newCountryPoints, newSubdivisionPoints }),
    [project, editedGeometries, drawingPoints, newCountryPoints, newSubdivisionPoints]);
  const latestProject = useRef({ project, hasDraftChanges, revision });
  useEffect(() => { latestProject.current = { project, hasDraftChanges, revision }; }, [project, hasDraftChanges, revision]);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  const confirmDiscardDraft = useCallback(() =>
    !hasDraftChanges || window.confirm('Discard the unfinished territory edit?'), [hasDraftChanges]);

  const handleSetEditMode = useCallback((mode: 'vertices' | 'draw' | null) => {
    if (drawingPoints.length && !window.confirm('Discard the unfinished drawn territory?')) return;
    setEditMode(mode);
    setDrawingPoints([]);
    setNewCountryPoints([]);
    setNewSubdivisionPoints([]);
    setIsAddingCountry(false);
    setIsAddingSubdivisionFor(null);
  }, [drawingPoints.length]);

  const onMouseLeave = useCallback(() => {
    setHoveredCountry(null);
  }, []);

  // Prepare both collections before committing so cancellation cannot leave a partial edit.
  const commitCountryGeometryChanges = useCallback((updatedEdits: Record<string, CountryData>): boolean => {
    const updatedSubdivisions = { ...subdivisions };
    const removed: string[] = [];
    try {
      for (const [id, subdivision] of Object.entries(subdivisions)) {
        const parentId = subdivision.parent_id;
        const parentEdit = updatedEdits[parentId];
        if (!parentEdit || parentEdit.geometry === undefined || parentEdit.geometry === countryEdits[parentId]?.geometry) continue;
        const clipped = parentEdit.geometry === null ? null : turf.intersect(turf.featureCollection([
          turf.feature(subdivision.geometry as Polygon | MultiPolygon),
          turf.feature(parentEdit.geometry as Polygon | MultiPolygon),
        ]));
        if (clipped) updatedSubdivisions[id] = { ...subdivision, geometry: clipped.geometry };
        else {
          delete updatedSubdivisions[id];
          removed.push(id);
        }
      }
    } catch {
      alert('The subdivisions could not be adjusted to the new country borders. No changes were applied; please revise the boundary and try again.');
      return false;
    }
    if (removed.length && !window.confirm(
      `These subdivisions would have no territory left inside their country and will be deleted:\n\n${removed.map(id => `${subdivisions[id].name} (${getCountryData(subdivisions[id].parent_id).name})`).join('\n')}\n\nApply the country changes?`
    )) return false;
    setCountryEdits(updatedEdits);
    setSubdivisions(updatedSubdivisions);
    if (selectedSubdivision && !Object.hasOwn(updatedSubdivisions, selectedSubdivision)) setSelectedSubdivision(null);
    return true;
  }, [subdivisions, countryEdits, selectedSubdivision, getCountryData]);

  const onClick = useCallback((e: MapLayerMouseEvent) => {
    if (e.originalEvent.detail === 2) return;
    
    const clickedVertex = e.features?.find(
      (f) => f.layer?.id === 'vertices-layer' || f.layer?.id === 'new-vertices-layer'
    );
    if (clickedVertex) return;

    if (absorbingCountry) {
      const feature = e.features?.find(f => f.properties?.territoryId);
      if (!feature) {
        setAbsorbingCountry(null);
        return;
      }

      const targetName = feature.properties?.territoryId;
      if (!targetName || targetName === absorbingCountry) return;

      const sourceGeometry = countryEdits[absorbingCountry]?.geometry ?? countriesById.get(absorbingCountry)?.geometry;
      const targetGeometry = countryEdits[targetName]?.geometry ?? countriesById.get(targetName)?.geometry;
      if (!sourceGeometry || !targetGeometry) return;

      const confirmed = window.confirm(`Absorb ${getCountryData(absorbingCountry).name} into ${getCountryData(targetName).name}?`);
      if (!confirmed) {
        setAbsorbingCountry(null);
        return;
      }

      const sourceFeature = turf.feature(sourceGeometry as Polygon | MultiPolygon);
      const targetFeature = turf.feature(targetGeometry as Polygon | MultiPolygon);
      const unioned = turf.union(turf.featureCollection([sourceFeature, targetFeature]));

      if (!commitCountryGeometryChanges({
        ...countryEdits,
        [absorbingCountry]: {
          ...getCountryData(absorbingCountry),
          geometry: null
        },
        [targetName]: {
          ...getCountryData(targetName),
          geometry: unioned ? unioned.geometry : targetGeometry
        }
      })) return;

      setAbsorbingCountry(null);
      setSelectedCountry(null);
      setSelectedSubdivision(null);
      setEditingCountry(null);
      setEditMode(null);
      return;
    }

    if (isAddingSubdivisionFor) {
      const { lngLat } = e;
      setNewSubdivisionPoints(prev => [...prev, [lngLat.lng, lngLat.lat]]);
      return;
    }

    if (isAddingCountry) {
      const { lngLat } = e;
      setNewCountryPoints(prev => [...prev, [lngLat.lng, lngLat.lat]]);
      return;
    }
    if (editMode === 'draw') {
      const { lngLat } = e;
      setDrawingPoints(prev => [...prev, [lngLat.lng, lngLat.lat]]);
      return;
    }

    if (editMode === 'vertices' && e.features?.[0]?.layer?.id === 'editing-country-border') {
      if (!editingCountry) return;

      const clickPoint = turf.point([e.lngLat.lng, e.lngLat.lat]);
      const originalFeature = countriesById.get(editingCountry);
      const base = editedGeometries[editingCountry] ?? originalFeature?.geometry;
      if (!base) return;

      if (base.type === 'Polygon') {
        let bestRingIndex = 0;
        let bestSegmentIndex = 0;
        let bestDistance = Infinity;

        base.coordinates.forEach((ring: number[][], ringIndex: number) => {
          const line = turf.lineString(ring);
          const nearest = turf.nearestPointOnLine(line, clickPoint);
          if (nearest.properties.dist < bestDistance) {
            bestDistance = nearest.properties.dist;
            bestRingIndex = ringIndex;
            bestSegmentIndex = nearest.properties.segmentIndex ?? 0;
          }
        });

        const updated = withUpdatedRing(base, 0, bestRingIndex, (ring) => {
          const newRing = [...ring];
          newRing.splice(bestSegmentIndex + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
          return newRing;
        });
        setEditedGeometries(prev => ({ ...prev, [editingCountry]: updated }));
      } else if (base.type === 'MultiPolygon') {
        let bestPolygonIndex = 0;
        let bestRingIndex = 0;
        let bestSegmentIndex = 0;
        let bestDistance = Infinity;

        base.coordinates.forEach((polygon: number[][][], polygonIndex: number) => {
          polygon.forEach((ring: number[][], ringIndex: number) => {
            const line = turf.lineString(ring);
            const nearest = turf.nearestPointOnLine(line, clickPoint);
            if (nearest.properties.dist < bestDistance) {
              bestDistance = nearest.properties.dist;
              bestPolygonIndex = polygonIndex;
              bestRingIndex = ringIndex;
              bestSegmentIndex = nearest.properties.segmentIndex ?? 0;
            }
          });
        });

        const updated = withUpdatedRing(base, bestPolygonIndex, bestRingIndex, (ring) => {
          const newRing = [...ring];
          newRing.splice(bestSegmentIndex + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
          return newRing;
        });
        setEditedGeometries(prev => ({ ...prev, [editingCountry]: updated }));
      }

      return;
    }

    const subdivisionFeature = e.features?.find(f => f.properties?.subdivisionId);
    if (subdivisionFeature?.properties?.subdivisionId) {
      const subdivisionId = subdivisionFeature.properties.subdivisionId;
      if (subdivisionId !== selectedSubdivision && !confirmDiscardDraft()) return;
      setSelectedSubdivision(subdivisionId);
      setSelectedCountry(subdivisionFeature.properties.parentTerritoryId ?? subdivisions[subdivisionId]?.parent_id ?? null);
      setEditingCountry(null);
      setEditMode(null);
      return;
    }

    const feature = e.features?.find(f => f.properties?.territoryId);
    if (feature?.properties?.territoryId !== selectedCountry && !confirmDiscardDraft()) return;
    if (feature?.properties?.territoryId !== selectedCountry) setSubdivisionsShownFor(null);
    if (feature?.properties?.territoryId) {
      const name = feature.properties?.territoryId;
      setSelectedCountry(name);
      setSelectedSubdivision(null);
      if (name !== selectedCountry) { setEditingCountry(null); setEditMode(null); }
    } else {
      setSelectedCountry(null);
      setSelectedSubdivision(null);
      setEditingCountry(null);
      setEditMode(null);
    }
  }, [editMode, editingCountry, editedGeometries, isAddingCountry, isAddingSubdivisionFor, absorbingCountry, countryEdits, countriesById, selectedCountry, selectedSubdivision, subdivisions, confirmDiscardDraft, getCountryData, commitCountryGeometryChanges]);

  const onDblClick = useCallback((e: MapLayerMouseEvent) => {
    e.preventDefault();

    if (isAddingSubdivisionFor) {
      if (newSubdivisionPoints.length < 3) return;

      const parentGeometry = getCountryGeometry(isAddingSubdivisionFor);
      if (!parentGeometry) {
        setNewSubdivisionPoints([]);
        setDraggingVertex(null);
        alert('The selected country has no geometry for subdivision clipping.');
        return;
      }

      const rawGeometry = {
        type: 'Polygon' as const,
        coordinates: [[...newSubdivisionPoints, newSubdivisionPoints[0]]]
      };

      let clipped: Feature<Polygon | MultiPolygon> | null;
      let updatedSubdivisions = subdivisions;
      try {
        clipped = turf.intersect(turf.featureCollection([
          turf.feature(rawGeometry),
          turf.feature(parentGeometry as Polygon | MultiPolygon)
        ]));
        if (!clipped) {
          setNewSubdivisionPoints([]);
          setDraggingVertex(null);
          alert('This subdivision is outside the selected country. The drawing was cleared; draw a new boundary inside the country.');
          return;
        }
        if (!allowOverlapping) {
          updatedSubdivisions = trimSubdivisionOverlaps(subdivisions, {
            parent_id: isAddingSubdivisionFor, name: '', color: '', geometry: clipped.geometry,
          });
        }
      } catch {
        setNewSubdivisionPoints([]);
        setDraggingVertex(null);
        alert('This subdivision boundary could not be processed. The drawing was cleared; please draw it again.');
        return;
      }

      const absorbed = Object.keys(subdivisions).filter(id => !Object.hasOwn(updatedSubdivisions, id));
      if (absorbed.length && !window.confirm(
        `This action will completely absorb the following subdivisions:\n\n${absorbed.map(id => subdivisions[id].name).join('\n')}\n\nContinue?`
      )) return;
      const name = prompt('Name your new subdivision:')?.trim();
      if (!name) return;
      let id: string;
      do { id = `subdivision-${crypto.randomUUID()}`; } while (Object.hasOwn(subdivisions, id));
      setSubdivisions({
        ...updatedSubdivisions,
        [id]: {
          parent_id: isAddingSubdivisionFor,
          name,
          color: '#7dd3fc',
          geometry: clipped.geometry,
          properties: {}
        }
      });
      setSelectedSubdivision(subdivisionsShownFor === isAddingSubdivisionFor ? id : null);
      setSelectedCountry(isAddingSubdivisionFor);
      setIsAddingSubdivisionFor(null);
      setNewSubdivisionPoints([]);
      return;
    }

    if (isAddingCountry) {
      if (newCountryPoints.length < 3) return;

      const name = prompt('Name your new country:')?.trim();
      if (!name) return;
      let id: string;
      do { id = `country-${crypto.randomUUID()}`; } while (countriesById.has(id) || Object.hasOwn(countryEdits, id));

      const rawGeometry = {
        type: 'Polygon' as const,
        coordinates: [[...newCountryPoints, newCountryPoints[0]]]
      };

      const clipped = clipGeometryToLand(rawGeometry, seaPolygons);
      if (!clipped) {
        alert('This polygon is entirely inside the sea and cannot be created.');
        return;
      }
      const newGeometry = clipped;

      const updatedEdits = { ...countryEdits };

      if (!allowOverlapping) {
        const newFeature = turf.feature(newGeometry);
        const newBbox = turf.bbox(newFeature);
        const countriesToAbsorb: string[] = [];

        getAbsorptionCandidates(countryEdits, countriesData).forEach(({ name: countryName, geometry: otherGeometry }) => {
          const otherBbox = turf.bbox(otherGeometry);
          if (!bboxesOverlap(newBbox, otherBbox)) return;

          const otherFeature = turf.feature(otherGeometry as Polygon | MultiPolygon);

          try {
            const intersection = turf.intersect(turf.featureCollection([newFeature, otherFeature]));
            if (!intersection) return;

            const difference = turf.difference(turf.featureCollection([otherFeature, newFeature]));

            if (!difference) {
              countriesToAbsorb.push(countryName);
            } else {
              updatedEdits[countryName] = {
                ...getCountryData(countryName),
                geometry: difference.geometry
              };
            }
          } catch {
            return;
          }
        });

        if (countriesToAbsorb.length > 0) {
          const confirmed = window.confirm(
            `This action will completely absorb the following countries:\n\n${countriesToAbsorb.map(id => getCountryData(id).name).join('\n')}\n\nContinue?`
          );
          if (!confirmed) return;
          countriesToAbsorb.forEach(absorbedName => {
            updatedEdits[absorbedName] = {
              ...getCountryData(absorbedName),
              geometry: null
            };
          });
        }
      }

      updatedEdits[id] = {
        name,
        color: '#dcdcdc',
        geometry: newGeometry,
        properties: {}
      };

      if (!commitCountryGeometryChanges(updatedEdits)) return;
      setIsAddingCountry(false);
      setNewCountryPoints([]);
      return;
    }

    const feature = e.features?.[0];
    if (feature?.properties?.territoryId) {
      if (!confirmDiscardDraft()) return;
      const name = feature.properties?.territoryId;
      setEditingCountry(name);
      setSelectedCountry(name);
      const isNewCountry = !countriesById.has(name);
      const geometry = isNewCountry
        ? countryEdits[name]?.geometry
        : countryEdits[name]?.geometry ?? countriesById.get(name)?.geometry;
      setEditedGeometries(prev => ({
        ...prev,
        [name]: geometry
      }));
    }
  }, [isAddingSubdivisionFor, newSubdivisionPoints, getCountryGeometry, subdivisions, subdivisionsShownFor, isAddingCountry, newCountryPoints, countryEdits, allowOverlapping, seaPolygons, countriesById, countriesData, confirmDiscardDraft, getCountryData, commitCountryGeometryChanges]);

  const handlePanelChange = useCallback((data: CountryData) => {
    if (!selectedCountry) return;
    setCountryEdits(prev => ({ ...prev, [selectedCountry]: { ...prev[selectedCountry], ...data } }));
  }, [selectedCountry]);

  const handleSubdivisionChange = useCallback((data: Pick<SubdivisionData, 'name' | 'color'>) => {
    if (!selectedSubdivision) return;
    setSubdivisions(prev => ({
      ...prev,
      [selectedSubdivision]: { ...prev[selectedSubdivision], ...data }
    }));
  }, [selectedSubdivision]);

  const handleDeleteSubdivision = useCallback(() => {
    if (!selectedSubdivision) return;
    const confirmed = window.confirm(`Delete ${subdivisions[selectedSubdivision]?.name ?? 'this subdivision'} completely?`);
    if (!confirmed) return;
    setSubdivisions(prev => {
      const next = { ...prev };
      delete next[selectedSubdivision];
      return next;
    });
    setSelectedSubdivision(null);
  }, [selectedSubdivision, subdivisions]);

  const handleDeleteCountry = useCallback(() => {
    if (!selectedCountry) return;
    const subdivisionCount = Object.values(subdivisions).filter(subdivision => subdivision.parent_id === selectedCountry).length;
    const confirmed = window.confirm(
      subdivisionCount > 0
        ? `Delete ${getCountryData(selectedCountry).name} and its ${subdivisionCount} subdivision${subdivisionCount === 1 ? '' : 's'} completely?`
        : `Delete ${getCountryData(selectedCountry).name} completely?`
    );
    if (!confirmed) return;

    setCountryEdits(prev => ({
      ...prev,
      [selectedCountry]: {
        ...getCountryData(selectedCountry),
        geometry: null
      }
    }));
    setSubdivisions(prev => Object.fromEntries(
      Object.entries(prev).filter(([, subdivision]) => subdivision.parent_id !== selectedCountry)
    ));
    setSelectedCountry(null);
    setSelectedSubdivision(null);
    setEditingCountry(null);
    setEditMode(null);
  }, [selectedCountry, getCountryData, subdivisions]);

  const handleStartAbsorb = useCallback(() => {
    setAbsorbingCountry(selectedCountry);
  }, [selectedCountry]);

  const handleCancelAbsorb = useCallback(() => {
    setAbsorbingCountry(null);
  }, []);

  const handleStartSubdivision = useCallback(() => {
    if (!selectedCountry || !getCountryGeometry(selectedCountry)) return;
    if (!confirmDiscardDraft()) return;
    setSelectedSubdivision(null);
    setIsAddingSubdivisionFor(selectedCountry);
    setNewSubdivisionPoints([]);
    setIsAddingCountry(false);
    setNewCountryPoints([]);
    setEditingCountry(null);
    setEditMode(null);
  }, [selectedCountry, getCountryGeometry, confirmDiscardDraft]);

  const handleCancelSubdivision = useCallback(() => {
    setIsAddingSubdivisionFor(null);
    setNewSubdivisionPoints([]);
  }, []);

  const handleToggleOverlapping = useCallback(() => {
    if (!allowOverlapping) {
      setAllowOverlapping(true);
      return;
    }
    try {
      let resolved: Record<string, SubdivisionData> = {};
      for (const [id, subdivision] of Object.entries(subdivisions)) {
        resolved = { ...trimSubdivisionOverlaps(resolved, subdivision), [id]: subdivision };
      }
      const absorbed = Object.keys(subdivisions).filter(id => !Object.hasOwn(resolved, id));
      if (absorbed.length && !window.confirm(
        `Turning overlapping off will completely absorb the following subdivisions:\n\n${absorbed.map(id => subdivisions[id].name).join('\n')}\n\nContinue?`
      )) return;
      setSubdivisions(resolved);
      if (selectedSubdivision && !Object.hasOwn(resolved, selectedSubdivision)) setSelectedSubdivision(null);
      setAllowOverlapping(false);
    } catch {
      alert('Subdivision overlaps could not be resolved. Overlapping is still on and your subdivisions have not changed.');
    }
  }, [allowOverlapping, subdivisions, selectedSubdivision]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    if (hasDraftChanges) {
      alert('Finish the territory edit with Done (or finish the new polygon) before saving.');
      return false;
    }
    const name = currentWorldId ? currentWorldName! : prompt('Name your world:')?.trim();
    if (!name) return false;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const payload = worldPayload(name, project);
      const saved = currentWorldId
        ? await api.updateWorld(currentWorldId, payload)
        : await api.createWorld(payload);
      setCurrentWorldId(saved.id!);
      setCurrentWorldName(saved.name);
      setSavedProject(project);
      const isCurrent = latestProject.current.project === project && !latestProject.current.hasDraftChanges;
      alert(isCurrent ? 'World saved!' : 'World saved. Newer changes are still unsaved.');
      return isCurrent;
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not save the world.');
      return false;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [currentWorldId, currentWorldName, project, hasDraftChanges]);

  const confirmDiscardUnsavedChanges = useCallback(async () => {
    if (savingRef.current) return false;
    return confirmReplacement(hasUnsavedChanges, message => window.confirm(message), handleSave);
  }, [hasUnsavedChanges, handleSave]);
  const confirmCurrentChanges = useRef(confirmDiscardUnsavedChanges);
  useEffect(() => { confirmCurrentChanges.current = confirmDiscardUnsavedChanges; }, [confirmDiscardUnsavedChanges]);

  const resetEditing = useCallback(() => {
    setSubdivisionsShownFor(null);
    setSelectedCountry(null);
    setSelectedSubdivision(null);
    setHoveredCountry(null);
    setEditingCountry(null);
    setEditMode(null);
    setEditedGeometries({});
    setDrawingPoints([]);
    setNewCountryPoints([]);
    setNewSubdivisionPoints([]);
    setIsAddingCountry(false);
    setIsAddingSubdivisionFor(null);
    setDraggingVertex(null);
    setAbsorbingCountry(null);
  }, []);

  const handleLoad = useCallback(async (world: WorldData) => {
    try {
      const request = ++loadRequest.current;
      if (!await confirmCurrentChanges.current()) return;
      const revision = latestProject.current.revision;
      // Refresh after a possible save; the panel may hold an older copy of this world.
      const fresh = await api.getWorld(world.id!);
      if (request !== loadRequest.current) return;
      if (latestProject.current.revision !== revision) {
        alert('The world was not loaded because you made new changes. Try loading it again.');
        return;
      }
      const restored = restoreWorld(fresh, defaultCountriesDataRaw);
      const { land, sea } = splitSeaFeatures(restored.base_map!);
      setBaseMap(restored.base_map!);
      setCountriesData(land);
      setSeaPolygons(sea);
      setCountryEdits(restored.edits);
      setSubdivisions(restored.subdivisions);
      setCurrentWorldId(fresh.id!);
      setCurrentWorldName(fresh.name);
      setBackgroundImage(restored.background_image);
      setBackgroundBounds(restored.background_bounds);
      setAllowOverlapping(restored.allow_overlapping);
      setSavedProject(restored);
      resetEditing();
      setShowWorldsPanel(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not load this world.');
    }
  }, [resetEditing]);

  const handleUploadBackgroundImage = useCallback(async (file: File) => {
    try {
      const { url } = await api.uploadBackgroundImage(file);

      const map = mapRef.current?.getMap();
      const bounds = map?.getBounds();

      const nextBounds: BackgroundBounds = bounds
        ? [
            [bounds.getWest(), bounds.getNorth()],
            [bounds.getEast(), bounds.getNorth()],
            [bounds.getEast(), bounds.getSouth()],
            [bounds.getWest(), bounds.getSouth()]
          ]
        : [
            [-180, 85],
            [180, 85],
            [180, -85],
            [-180, -85]
          ];

      setBackgroundImage(url);
      setBackgroundBounds(nextBounds);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not upload the background.');
    }
  }, []);

  const handleResetBackgroundImage = useCallback(() => {
    setBackgroundImage(null);
    setBackgroundBounds(null);
  }, []);

  const handleImportCountries = useCallback(async (file: File) => {
    try {
      const request = ++loadRequest.current;
      // Validate before asking to discard anything.
      const normalized = normalizeBaseMap(JSON.parse(await file.text()));
      if (request !== loadRequest.current || !await confirmCurrentChanges.current()) return;
      if (request !== loadRequest.current) return;
      const { land, sea } = splitSeaFeatures(normalized);
      setBaseMap(normalized);
      setCountriesData(land);
      setSeaPolygons(sea);
      setCountryEdits({});
      setSubdivisions({});
      setCurrentWorldId(null);
      setCurrentWorldName(null);
      setBackgroundImage(null);
      setBackgroundBounds(null);
      setAllowOverlapping(false);
      resetEditing();
      // Keep the old baseline: an imported map is a new, unsaved project.
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not import this map.');
    }
  }, [resetEditing]);


  const handleDoneEditing = useCallback(() => {
    if (!editingCountry) return;

    let geometry = editedGeometries[editingCountry];

    if (drawingPoints.length >= 3) {
      const originalFeature = countriesById.get(editingCountry);
      const baseGeometry = geometry
        ?? countryEdits[editingCountry]?.geometry
        ?? originalFeature?.geometry;

      const drawnPolygon = turf.polygon([[...drawingPoints, drawingPoints[0]]]);
      const basePolygon = turf.feature(baseGeometry as Polygon | MultiPolygon);
      const unioned = turf.union(turf.featureCollection([basePolygon, drawnPolygon]));
      if (unioned) geometry = unioned.geometry;
    }

    if (geometry) {
      const clipped = clipGeometryToLand(geometry as Polygon | MultiPolygon, seaPolygons);
      if (!clipped) {
        alert('This edit would leave the country entirely inside the sea and was discarded.');
        setEditingCountry(null);
        setEditMode(null);
        setDrawingPoints([]);
        return;
      }
      geometry = clipped;
    }

    if (geometry) {
      const newGeometry = turf.feature(geometry as Polygon | MultiPolygon);
      const updatedEdits = { ...countryEdits };

      if (!allowOverlapping) {
        const newBbox = turf.bbox(newGeometry);
        const countriesToAbsorb: string[] = [];

        getAbsorptionCandidates(countryEdits, countriesData).forEach(({ name, geometry: otherGeometry }) => {
          if (name === editingCountry) return;

          const otherBbox = turf.bbox(otherGeometry);
          if (!bboxesOverlap(newBbox, otherBbox)) return;

          const otherFeature = turf.feature(otherGeometry as Polygon | MultiPolygon);

          try {
            const intersection = turf.intersect(turf.featureCollection([newGeometry, otherFeature]));
            if (!intersection) return;

            const difference = turf.difference(turf.featureCollection([otherFeature, newGeometry]));

            if (!difference) {
              countriesToAbsorb.push(name);
            } else {
              updatedEdits[name] = {
                ...getCountryData(name),
                geometry: difference.geometry
              };
            }
          } catch {
            return;
          }
        });

        if (countriesToAbsorb.length > 0) {
          const confirmed = window.confirm(
            `This action will completely absorb the following countries:\n\n${countriesToAbsorb.map(id => getCountryData(id).name).join('\n')}\n\nContinue?`
          );
          if (!confirmed) return;
          countriesToAbsorb.forEach(name => {
            updatedEdits[name] = {
              ...getCountryData(name),
              geometry: null
            };
          });
        }

      }
      updatedEdits[editingCountry] = {
        ...getCountryData(editingCountry),
        geometry
      };
      if (!commitCountryGeometryChanges(updatedEdits)) return;
    }

    setEditingCountry(null);
    setEditMode(null);
    setDrawingPoints([]);
  }, [editingCountry, editedGeometries, drawingPoints, countryEdits, allowOverlapping, seaPolygons, countriesById, countriesData, getCountryData, commitCountryGeometryChanges]);

  const editingVertices = useMemo(() => {
    if (!editingCountry) return null;

    const feature = editedGeometries[editingCountry]
      ? { geometry: editedGeometries[editingCountry] }
      : countriesById.get(editingCountry)
      ?? (countryEdits[editingCountry]?.geometry ? { geometry: countryEdits[editingCountry].geometry } : null);

    if (!feature) return null;

    const allCoords: { coord: number[]; polygonIndex: number; ringIndex: number; vertexIndex: number }[] = [];

    if (editMode === 'vertices') {
      if (feature.geometry.type === 'Polygon') {
        feature.geometry.coordinates.forEach((ring: number[][], ringIndex: number) => {
          ring.forEach((coord: number[], vertexIndex: number) => {
            allCoords.push({ coord, polygonIndex: 0, ringIndex, vertexIndex });
          });
        });
      } else if (feature.geometry.type === 'MultiPolygon') {
        feature.geometry.coordinates.forEach((polygon: number[][][], polygonIndex: number) => {
          polygon.forEach((ring: number[][], ringIndex: number) => {
            ring.forEach((coord: number[], vertexIndex: number) => {
              allCoords.push({ coord, polygonIndex, ringIndex, vertexIndex });
            });
          });
        });
      }
    }

    const shouldShowVertexMarkers = editMode === 'vertices' && allCoords.length > 0;
    const shouldShowDrawingPoints = editMode === 'draw' && drawingPoints.length > 0;

    if (!shouldShowVertexMarkers && !shouldShowDrawingPoints) return null;

    return {
      type: 'FeatureCollection' as const,
      features: [
        ...(shouldShowVertexMarkers ? allCoords.map((item, index) => ({
          type: 'Feature' as const,
          properties: {
            index,
            polygonIndex: item.polygonIndex,
            ringIndex: item.ringIndex,
            vertexIndex: item.vertexIndex,
            isDrawingPoint: false
          },
          geometry: {
            type: 'Point' as const,
            coordinates: item.coord
          }
        })) : []),
        ...(shouldShowDrawingPoints ? drawingPoints.map((coord, index) => ({
          type: 'Feature' as const,
          properties: {
            index: allCoords.length + index,
            polygonIndex: -1,
            ringIndex: -1,
            vertexIndex: index,
            isDrawingPoint: true
          },
          geometry: {
            type: 'Point' as const,
            coordinates: coord
          }
        })) : [])
      ]
    };
  }, [editingCountry, editedGeometries, countryEdits, editMode, drawingPoints, countriesById]);

  const editingCountryData = useMemo(() => {
    if (!editingCountry) return null;

    const base = editedGeometries[editingCountry] ?? countriesById.get(editingCountry)?.geometry;
    if (!base) return null;

    let geometry = base;
    if (drawingPoints.length >= 3) {
      try {
        const drawnPolygon = turf.polygon([[...drawingPoints, drawingPoints[0]]]);
        const basePolygon = turf.feature(base as Polygon | MultiPolygon);
        const unioned = turf.union(turf.featureCollection([basePolygon, drawnPolygon]));
        if (unioned) geometry = unioned.geometry;
      } catch {
        geometry = base;
      }
    }

    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: {
          name: getCountryData(editingCountry).name,
          territoryId: editingCountry,
          customColor: countryEdits[editingCountry]?.color ?? countriesById.get(editingCountry)?.properties?.customColor ?? '#dcdcdc'
        },
        geometry
      }]
    };
  }, [editingCountry, editedGeometries, drawingPoints, countryEdits, countriesById, getCountryData]);

  const newTerritoryData = useMemo(() => {
    const points = isAddingSubdivisionFor ? newSubdivisionPoints : newCountryPoints;
    if ((!isAddingCountry && !isAddingSubdivisionFor) || points.length === 0) return null;

    return {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { isShape: true },
          geometry: points.length >= 3
            ? { type: 'Polygon' as const, coordinates: [[...points, points[0]]] }
            : { type: 'LineString' as const, coordinates: points }
        },
        ...points.map((coord, index) => ({
          type: 'Feature' as const,
          properties: { isVertex: true, index },
          geometry: { type: 'Point' as const, coordinates: coord }
        }))
      ]
    };
  }, [isAddingCountry, isAddingSubdivisionFor, newCountryPoints, newSubdivisionPoints]);

  const allCountriesData = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: exportMap(countriesData, countryEdits).features
      .filter(feature => feature.id !== editingCountry)
      .map(feature => ({ ...feature, properties: { ...feature.properties, territoryId: String(feature.id) } })),
  }), [countriesData, countryEdits, editingCountry]);

  const allSubdivisionsData = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: Object.entries(subdivisions)
      .filter(([, subdivision]) => subdivision.parent_id === selectedCountry && subdivision.parent_id === subdivisionsShownFor)
      .map(([id, subdivision]) => ({
      type: 'Feature' as const,
      id,
      properties: {
        ...subdivision.properties,
        name: subdivision.name,
        subdivisionId: id,
        parentTerritoryId: subdivision.parent_id,
        customColor: subdivision.color,
      },
      geometry: subdivision.geometry,
    })),
  }), [subdivisions, selectedCountry, subdivisionsShownFor]);

  const handleExportCountries = useCallback(() => {
    if (hasDraftChanges) {
      alert('Finish the territory edit before exporting.');
      return;
    }
    try {
      const exported = normalizeBaseMap(exportMap(baseMap, countryEdits), true);
      downloadJSON(exported, 'countries.geojson');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not export this map.');
    }
  }, [baseMap, countryEdits, hasDraftChanges]);


  const onVertexMouseDown = useCallback((e: MapLayerMouseEvent, feature: VertexFeature) => {
    e.preventDefault();

    if (feature.layer.id === 'new-vertices-layer') {
      setDraggingVertex({
        index: feature.properties?.index,
        polygonIndex: -1,
        ringIndex: -1,
        vertexIndex: feature.properties?.index,
        isDrawingPoint: false,
        isNewCountryVertex: true
      });
      return;
    }

    setDraggingVertex({
      index: feature.properties?.index,
      polygonIndex: feature.properties?.polygonIndex,
      ringIndex: feature.properties?.ringIndex,
      vertexIndex: feature.properties?.vertexIndex,
      isDrawingPoint: feature.properties?.isDrawingPoint
    });
  }, []);

  const onMouseMoveWithDrag = useCallback((e: MapLayerMouseEvent) => {
    if (draggingVertex?.isNewCountryVertex) {
      const { lngLat } = e;
      const updatePoints = (prev: number[][]) => {
        const updated = [...prev];
        updated[draggingVertex.index] = [lngLat.lng, lngLat.lat];
        return updated;
      };
      if (isAddingSubdivisionFor) {
        setNewSubdivisionPoints(updatePoints);
      } else {
        setNewCountryPoints(updatePoints);
      }
      return;
    }

    const feature = e.features?.find(f => f.properties?.territoryId || f.properties?.subdivisionId);
    if (!draggingVertex || !editingCountry) {
      setHoveredCountry(feature?.properties?.territoryId ?? null);
      return;
    }

    const { lngLat } = e;
    const newCoord = [lngLat.lng, lngLat.lat];

    if (draggingVertex.isDrawingPoint) {
      setDrawingPoints(prev => {
        const updated = [...prev];
        updated[draggingVertex.vertexIndex] = newCoord;
        return updated;
      });
      return;
    }

    setEditedGeometries(prev => {
      const originalFeature = countriesById.get(editingCountry);
      const base = prev[editingCountry] ?? originalFeature?.geometry;
      if (!base) return prev;

      const updated = withUpdatedRing(
        base,
        draggingVertex.polygonIndex,
        draggingVertex.ringIndex,
        (ring) => moveRingVertex(ring, draggingVertex.vertexIndex, newCoord)
      );
      return { ...prev, [editingCountry]: updated };
    });
  }, [draggingVertex, editingCountry, countriesById, isAddingSubdivisionFor]);

  const onMouseUp = useCallback(() => {
    setDraggingVertex(null);
  }, []);

  const handleDeleteVertex = useCallback((polygonIndex: number, ringIndex: number, vertexIndex: number) => {
    if (!editingCountry) return;

    setEditedGeometries(prev => {
      const originalFeature = countriesById.get(editingCountry);
      const base = prev[editingCountry] ?? originalFeature?.geometry;
      if (!base || (base.type !== 'Polygon' && base.type !== 'MultiPolygon')) return prev;

      const targetRing = base.type === 'Polygon'
        ? base.coordinates[ringIndex]
        : base.coordinates[polygonIndex][ringIndex];
      if (targetRing.length <= 4) return prev;

      const updated = withUpdatedRing(base, polygonIndex, ringIndex, (ring) => {
        const newRing = [...ring];
        newRing.splice(vertexIndex, 1);
        newRing[newRing.length - 1] = newRing[0];
        return newRing;
      });

      return { ...prev, [editingCountry]: updated };
    });
  }, [editingCountry, countriesById]);

  const handleDeleteDrawingPoint = useCallback((vertexIndex: number) => {
    setDrawingPoints(prev => prev.filter((_, i) => i !== vertexIndex));
  }, []);

  const handleDeleteNewCountryVertex = useCallback((vertexIndex: number) => {
    const updatePoints = (prev: number[][]) => {
      if (prev.length <= 3) return prev;
      return prev.filter((_, i) => i !== vertexIndex);
    };
    if (isAddingSubdivisionFor) {
      setNewSubdivisionPoints(updatePoints);
    } else {
      setNewCountryPoints(updatePoints);
    }
  }, [isAddingSubdivisionFor]);

  return (
    <div
      style={{ width: '100vw', height: '100vh' }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!mapRef.current) return;

        const map = mapRef.current.getMap();
        const rect = map.getContainer().getBoundingClientRect();
        const point = new maplibregl.Point(
          e.clientX - rect.left,
          e.clientY - rect.top
        );

        const candidateLayers = ['vertices-layer', 'new-vertices-layer'].filter(id => map.getLayer(id));
        if (candidateLayers.length === 0) return;
        
        const bbox: [[number, number], [number, number]] = [
          [point.x - 8, point.y - 8],
          [point.x + 8, point.y + 8]
        ];

        const renderedFeatures = map.queryRenderedFeatures(bbox, {
          layers: candidateLayers
        });

        if (renderedFeatures.length === 0) return;

        let closestFeature = renderedFeatures[0];
        let closestDistance = Infinity;

        renderedFeatures.forEach(f => {
          if (f.geometry.type !== 'Point') return;
          const coords = f.geometry.coordinates as [number, number];
          const projected = map.project(coords);
          const dx = projected.x - point.x;
          const dy = projected.y - point.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestFeature = f;
          }
        });

        if (closestDistance > 12) return;

        if (closestFeature.layer?.id === 'new-vertices-layer') {
          handleDeleteNewCountryVertex(closestFeature.properties?.index);
        } else if (!closestFeature.properties?.isDrawingPoint) {
          handleDeleteVertex(
            closestFeature.properties?.polygonIndex,
            closestFeature.properties?.ringIndex,
            closestFeature.properties?.vertexIndex
          );
        } else {
          handleDeleteDrawingPoint(closestFeature.properties?.vertexIndex);
        }
      }}
    >
      <Navbar
        onSave={handleSave}
        isSaving={isSaving}
        hasUnsavedChanges={hasUnsavedChanges}
        onMyWorlds={() => {
          setShowWorldsPanel(prev => !prev);
        }}
        allowOverlapping={allowOverlapping}
        onToggleOverlapping={handleToggleOverlapping}
      />
      <Sidebar
        isAddingCountry={isAddingCountry}
        onToggleAddCountry={() => {
          if (!confirmDiscardDraft()) return;
          setIsAddingCountry(prev => !prev);
          setNewCountryPoints([]);
          setIsAddingSubdivisionFor(null);
          setNewSubdivisionPoints([]);
          setSelectedSubdivision(null);
          setDrawingPoints([]);
          setEditMode(null);
          setEditingCountry(null);
        }}
        onImportCountries={handleImportCountries}
        onExportCountries={handleExportCountries}
        hasCustomBackground={!!backgroundImage}
        onUploadBackgroundImage={handleUploadBackgroundImage}
        onResetBackgroundImage={handleResetBackgroundImage}
      />
      <MapGL
        initialViewState={{ longitude: 0, latitude: 20, zoom: 1.5 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={BlankWorldMap}
        interactiveLayerIds={['subdivisions-fill', 'countries-fill', 'editing-country-fill', 'vertices-layer', 'editing-country-border', 'new-vertices-layer']}
        onMouseMove={onMouseMoveWithDrag}
        onMouseLeave={onMouseLeave}
        onDblClick={onDblClick}
        doubleClickZoom={false}
        onClick={onClick}
        onMouseUp={onMouseUp}
        dragRotate={false}
        onMouseDown={(e) => {
          if (e.originalEvent.button !== 0) return;
          const vertexFeature = e.features?.find(
            (f) => f.layer?.id === 'vertices-layer' || f.layer?.id === 'new-vertices-layer'
          );
          if (vertexFeature) {
            onVertexMouseDown(e, vertexFeature);
          }
        }}
        ref={mapRef}
      >
        {backgroundImage && backgroundBounds && (
          <Source
            id="custom-background"
            type="image"
            url={backgroundImage}
            coordinates={backgroundBounds}
          >
            <Layer id="custom-background-layer" type="raster" paint={{ 'raster-opacity': 1 }} />
          </Source>
        )}
        <Source id="countries" type="geojson" data={allCountriesData}>
          <Layer
            id="countries-fill"
            type="fill"
            paint={{
              'fill-color': [
                'case',
                ['==', ['get', 'territoryId'], selectedCountry], '#613e00',
                ['==', ['get', 'territoryId'], hoveredCountry], '#031a34',
                ['get', 'customColor']
              ],
              'fill-opacity': 0.5
            }}
          />
          <Layer
            id="countries-border"
            type="line"
            paint={{
              'line-color': '#1a1a2e',
              'line-width': 1
            }}
          />
        </Source>
        {allSubdivisionsData.features.length > 0 && (
          <Source id="subdivisions" type="geojson" data={allSubdivisionsData}>
            <Layer
              id="subdivisions-fill"
              type="fill"
              paint={{
                'fill-color': [
                  'case',
                  ['==', ['get', 'subdivisionId'], selectedSubdivision], '#0e7490',
                  ['get', 'customColor']
                ],
                'fill-opacity': 0.45
              }}
            />
            <Layer
              id="subdivisions-border"
              type="line"
              paint={{
                'line-color': '#0e7490',
                'line-width': 1.5
              }}
            />
          </Source>
        )}
        {editingCountryData && (
          <Source id="editing-country" type="geojson" data={editingCountryData}>
            <Layer
              id="editing-country-fill"
              type="fill"
              paint={{
                'fill-color': ['get', 'customColor'],
                'fill-opacity': 0.5
              }}
            />
            <Layer
              id="editing-country-border"
              type="line"
              paint={{
                'line-color': '#4f46e5',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  2, editMode === 'vertices' ? 3 : 1,
                  6, editMode === 'vertices' ? 5 : 2,
                  10, editMode === 'vertices' ? 8 : 2
                ]
              }}
            />
          </Source>
        )}
        {editingVertices && (
          <Source id="vertices" type="geojson" data={editingVertices}>
            <Layer
              id="vertices-layer"
              type="circle"
              paint={{
                'circle-radius': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  1, 4,
                  5, 5,
                  8, 8,
                  12, 12
                ],
                'circle-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#4f46e5'
              }}
            />
          </Source>
        )}
        {newTerritoryData && (
          <Source id="new-country" type="geojson" data={newTerritoryData}>
            <Layer
              id="new-country-fill"
              type="fill"
              filter={['has', 'isShape']}
              paint={{ 'fill-color': isAddingSubdivisionFor ? '#0891b2' : '#16a34a', 'fill-opacity': 0.6 }}
            />
            <Layer
              id="new-editing-country-border"
              type="line"
              paint={{
                'line-color': '#4f46e5',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  2, editMode === 'vertices' ? 3 : 1,
                  6, editMode === 'vertices' ? 5 : 2,
                  10, editMode === 'vertices' ? 8 : 2
                ]
              }}
            />
            <Layer
              id="new-vertices-layer"
              type="circle"
              paint={{
                'circle-radius': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  1, 4,
                  5, 5,
                  8, 8,
                  12, 12
                ],
                'circle-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#4f46e5'
              }}
            />
          </Source>
        )}
      </MapGL>

      {showWorldsPanel && (
        <WorldsPanel
          onLoad={handleLoad}
          currentWorldId={currentWorldId}
          busy={isSaving}
          onDeleteCurrent={() => { setCurrentWorldId(null); setCurrentWorldName(null); setSavedProject(initialProject); }}
          onClose={() => setShowWorldsPanel(false)}
        />
      )}

      {!showWorldsPanel && selectedSubdivision && subdivisions[selectedSubdivision] && (
        <SubdivisionPanel
          key={selectedSubdivision}
          data={subdivisions[selectedSubdivision]}
          parentName={getCountryData(subdivisions[selectedSubdivision].parent_id).name}
          onChange={handleSubdivisionChange}
          onClose={() => setSelectedSubdivision(null)}
          onDeleteSubdivision={handleDeleteSubdivision}
        />
      )}

      {!showWorldsPanel && selectedCountry && !selectedSubdivision && (
        <CountryPanel
          key={selectedCountry}
          countryId={selectedCountry}
          data={getCountryData(selectedCountry)}
          onChange={handlePanelChange}
          onClose={() => {
            if (!confirmDiscardDraft()) return;
            setSubdivisionsShownFor(null);
            handleCancelSubdivision();
            setSelectedCountry(null);
            setEditingCountry(null);
            setEditMode(null);
          }}
          editingCountry={editingCountry}
          editMode={editMode}
          onEnterEditMode={() => {
            setEditingCountry(selectedCountry);
            const isNewCountry = !countriesById.has(selectedCountry!);
            const geometry = isNewCountry
              ? countryEdits[selectedCountry!]?.geometry
              : countryEdits[selectedCountry!]?.geometry ??
                countriesById.get(selectedCountry!)?.geometry;
            if (!geometry) return;
            setEditedGeometries(prev => ({
              ...prev,
              [selectedCountry!]: geometry
            }));
          }}
          onSetEditMode={handleSetEditMode}
          onDoneEditing={handleDoneEditing}
          isAbsorbing={absorbingCountry === selectedCountry}
          subdivisionCount={Object.values(subdivisions).filter(subdivision => subdivision.parent_id === selectedCountry).length}
          showSubdivisions={subdivisionsShownFor === selectedCountry}
          onToggleSubdivisions={() => setSubdivisionsShownFor(prev => prev === selectedCountry ? null : selectedCountry)}
          isAddingSubdivision={isAddingSubdivisionFor === selectedCountry}
          onStartSubdivision={handleStartSubdivision}
          onCancelSubdivision={handleCancelSubdivision}
          onStartAbsorb={handleStartAbsorb}
          onCancelAbsorb={handleCancelAbsorb}
          onDeleteCountry={handleDeleteCountry}
        />
      )}
    </div>
  );
}

export default App;
