import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as world from '../src/world.ts';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const geometry = { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,0]]] };
const base = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'country-a', properties: { name: 'Original' }, geometry }] };
const code = ts.transpileModule(fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

// Exercise App's real event handlers/state transitions, with map rendering and HTTP isolated.
function editor() {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  let tree;
  const notices = [];
  const prompts = [];
  const confirmations = [];
  const confirmationMessages = [];
  const calls = [];
  const stored = new Map();
  const listeners = new Map();
  const equal = (a, b) => a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!equal(hooks[i]?.deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!equal(hooks[i]?.deps, deps)) effects.push(() => { hooks[i]?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; });
    },
  };
  const api = {
    async createWorld(payload) { const saved = JSON.parse(JSON.stringify({ ...payload, id: 1 })); stored.set(1, saved); calls.push(saved); return saved; },
    async updateWorld(id, payload) { const saved = JSON.parse(JSON.stringify({ ...payload, id })); stored.set(id, saved); calls.push(saved); return saved; },
    async getWorld(id) { return stored.get(id); },
  };
  const jsx = (type, props) => ({ type, props });
  function load(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-map-gl/maplibre') return { __esModule: true, default: 'Map', Source: 'Source', Layer: 'Layer' };
    if (name === 'maplibre-gl' || name.endsWith('.css')) return {};
    if (name.includes('countries_mid_res')) return JSON.stringify(base);
    if (name.includes('BlankWorldMap')) return {};
    if (name === './api') return { api };
    if (name === './world') return world;
    if (name.startsWith('./components/')) return name.split('/').at(-1);
    return require(name);
  }
  const exports = {};
  new Function('require', 'exports', 'window', 'alert', 'prompt', code)(load, exports, {
    confirm: message => { confirmationMessages.push(message); const value = confirmations.shift(); assert.notEqual(value, undefined, message); return value; },
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: event => listeners.delete(event),
  }, message => notices.push(message), () => prompts.shift() ?? null);
  function render() { cursor = 0; effects = []; tree = exports.default(); for (const effect of effects) effect(); }
  function get(type) {
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === type) return node.props;
      for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child); if (found) return found; }
    }
    return walk(tree);
  }
  function getAll(type) {
    const matches = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === type) matches.push(node.props);
      for (const child of [node.props?.children].flat(Infinity)) walk(child);
    }
    walk(tree);
    return matches;
  }
  function select(id = 'country-a') {
    const feature = get('Source').data.features.find(f => f.id === id);
    assert.ok(feature, `Missing rendered territory ${id}`);
    get('Map').onClick({ originalEvent: { detail: 1 }, features: [{ ...feature, layer: { id: 'countries-fill' } }] });
    render();
  }
  render();
  return { render, get, getAll, select, api, calls, stored, prompts, confirmations, confirmationMessages, notices, listeners };
}

test('selection stays clean and saving a name/color change does not delete the country', async () => {
  const e = editor();
  e.select();
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
  e.get('CountryPanel').onChange({ name: 'Renamed', color: '#123456' }); e.render();
  assert.equal(e.get('Navbar').hasUnsavedChanges, true);
  assert.equal(e.listeners.has('beforeunload'), true);
  e.prompts.push('Test');
  assert.equal(await e.get('Navbar').onSave(), true); e.render();
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
  assert.equal(e.listeners.has('beforeunload'), false);
  assert.equal(Object.hasOwn(e.calls[0].edits['country-a'], 'geometry'), false);
  assert.deepEqual(e.calls[0].base_map, base);
});

test('cancelled and failed saves prevent an import from replacing the map', async () => {
  const e = editor(); e.select();
  e.get('CountryPanel').onChange({ name: 'Changed', color: '#fff' }); e.render();
  const custom = { ...base, features: [{ ...base.features[0], properties: { name: 'Imported' } }] };
  const file = { text: async () => JSON.stringify(custom) };
  e.confirmations.push(true); // Name prompt returns null.
  await e.get('Sidebar').onImportCountries(file); e.render();
  assert.equal(e.get('CountryPanel').data.name, 'Changed');
  e.api.createWorld = async () => { throw new Error('HTTP 500'); };
  e.confirmations.push(true); e.prompts.push('Test');
  await e.get('Sidebar').onImportCountries(file); e.render();
  assert.equal(e.get('CountryPanel').data.name, 'Changed');
  assert.equal(e.get('Navbar').hasUnsavedChanges, true);
  assert.equal(e.notices.at(-1), 'HTTP 500');
});

test('import is dirty, saves its base map, and loading restores a clean complete project', async () => {
  const e = editor();
  const custom = { ...base, features: [{ ...base.features[0], properties: { name: 'Imported' } }] };
  await e.get('Sidebar').onImportCountries({ text: async () => JSON.stringify(custom) }); e.render();
  assert.equal(e.get('Navbar').hasUnsavedChanges, true);
  e.prompts.push('Imported world'); await e.get('Navbar').onSave(); e.render();
  assert.deepEqual(e.calls[0].base_map, custom);
  e.get('Navbar').onMyWorlds(); e.render();
  await e.get('WorldsPanel').onLoad(e.stored.get(1)); e.render();
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
  assert.equal(e.get('Source').data.features[0].properties.name, 'Imported');
});

test('new edits made while a save is pending stay dirty and block replacement', async () => {
  const e = editor(); e.select();
  e.get('CountryPanel').onChange({ name: 'First', color: '#fff' }); e.render();
  let finish;
  e.api.createWorld = payload => new Promise(resolve => { finish = () => resolve({ ...payload, id: 1 }); });
  e.prompts.push('Concurrent');
  const saving = e.get('Navbar').onSave(); e.render();
  assert.equal(e.get('Navbar').isSaving, true);
  assert.equal(await e.get('Navbar').onSave(), false);
  e.get('CountryPanel').onChange({ name: 'Later', color: '#fff' }); e.render();
  finish(); assert.equal(await saving, false); e.render();
  assert.equal(e.get('Navbar').hasUnsavedChanges, true);
});

test('save-then-load refreshes the panel snapshot instead of undoing the save', async () => {
  const e = editor(); e.select();
  e.prompts.push('World'); await e.get('Navbar').onSave(); e.render();
  const stale = e.stored.get(1);
  e.get('CountryPanel').onChange({ name: 'Newest', color: '#fff' }); e.render();
  e.get('Navbar').onMyWorlds(); e.render(); e.confirmations.push(true);
  await e.get('WorldsPanel').onLoad(stale); e.render(); e.select();
  assert.equal(e.get('CountryPanel').data.name, 'Newest');
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
});

test('changes made during a slow world load are not overwritten', async () => {
  const e = editor();
  let finish;
  e.api.getWorld = () => new Promise(resolve => { finish = resolve; });
  e.get('Navbar').onMyWorlds(); e.render();
  const loading = e.get('WorldsPanel').onLoad({ id: 2 });
  await new Promise(resolve => setImmediate(resolve));
  e.get('Navbar').onToggleOverlapping(); e.render();
  finish({ id: 2, name: 'Other', edits: {} });
  await loading; e.render();
  assert.equal(e.get('Navbar').allowOverlapping, true);
  assert.match(e.notices.at(-1), /not loaded/);
});

test('an import checks edits made while its file is being read', async () => {
  const e = editor();
  let finish;
  const importing = e.get('Sidebar').onImportCountries({ text: () => new Promise(resolve => { finish = resolve; }) });
  e.select(); e.get('CountryPanel').onChange({ name: 'Do not discard', color: '#fff' }); e.render();
  e.confirmations.push(false, false);
  finish(JSON.stringify(base)); await importing; e.render();
  assert.equal(e.get('CountryPanel').data.name, 'Do not discard');
  assert.equal(e.get('Navbar').hasUnsavedChanges, true);
});

test('geometry edits preserve country identity even when overlap is allowed', async () => {
  const e = editor(); e.select();
  e.get('Navbar').onToggleOverlapping(); e.render();
  e.get('CountryPanel').onEnterEditMode(); e.render();
  e.get('CountryPanel').onSetEditMode('draw'); e.render();
  for (const [lng, lat] of [[1,0], [3,0], [3,3]]) {
    e.get('Map').onClick({ originalEvent: { detail: 1 }, features: [], lngLat: { lng, lat } }); e.render();
  }
  e.prompts.push('Geometric');
  assert.equal(await e.get('Navbar').onSave(), false);
  assert.match(e.notices.at(-1), /Finish the territory/);
  e.get('CountryPanel').onDoneEditing(); e.render();
  assert.equal(await e.get('Navbar').onSave(), true); e.render();
  assert.equal(e.calls[0].edits['country-a'].name, 'Original');
  assert.equal(e.calls[0].edits['country-a'].color, '#dcdcdc');
  assert.notDeepEqual(e.calls[0].edits['country-a'].geometry, geometry);
});

test('same-name countries remain independently selectable, editable and deletable', async () => {
  const e = editor();
  const otherGeometry = { type: 'Polygon', coordinates: [[[4,0],[6,0],[6,2],[4,0]]] };
  const custom = { ...base, features: [base.features[0], { ...base.features[0], id: 'country-b', geometry: otherGeometry }] };
  await e.get('Sidebar').onImportCountries({ text: async () => JSON.stringify(custom) }); e.render();
  e.select('country-b');
  assert.equal(e.get('CountryPanel').countryId, 'country-b');
  e.get('CountryPanel').onChange({ name: 'Renamed', color: '#123456' }); e.render();
  e.select('country-a');
  assert.equal(e.get('CountryPanel').data.name, 'Original');
  assert.equal(e.get('CountryPanel').data.color, '#dcdcdc');
  e.select('country-b');
  assert.equal(e.get('CountryPanel').data.name, 'Renamed');
  e.confirmations.push(true);
  e.get('CountryPanel').onDeleteCountry(); e.render();
  assert.equal(e.confirmationMessages.at(-1), 'Delete Renamed completely?');
  assert.deepEqual(e.get('Source').data.features.map(f => f.id), ['country-a']);
  e.prompts.push('Independent countries'); await e.get('Navbar').onSave(); e.render();
  assert.equal(e.calls[0].schema_version, 3);
  assert.equal(e.calls[0].edits['country-b'].geometry, null);
  assert.equal(e.calls[0].edits['country-a'], undefined);
});

test('renaming a new polygon preserves its geometry and reloads under the same ID', async () => {
  const e = editor();
  e.get('Sidebar').onToggleAddCountry(); e.render();
  for (const [lng, lat] of [[4,0], [6,0], [6,2]]) {
    e.get('Map').onClick({ originalEvent: { detail: 1 }, features: [], lngLat: { lng, lat } }); e.render();
  }
  e.prompts.push('Original'); // A duplicate label must not overwrite the original country.
  e.get('Map').onDblClick({ preventDefault() {}, features: [] }); e.render();
  const created = e.get('Source').data.features.find(f => f.id !== 'country-a');
  assert.ok(created);
  assert.equal(created.properties.name, 'Original');
  e.select(created.id);
  e.get('CountryPanel').onChange({ name: 'Renamed custom', color: '#123456' }); e.render();
  const renamed = e.get('Source').data.features.find(f => f.id === created.id);
  assert.deepEqual(renamed.geometry, created.geometry);
  e.prompts.push('Created country'); await e.get('Navbar').onSave(); e.render();
  e.get('Navbar').onMyWorlds(); e.render();
  await e.get('WorldsPanel').onLoad(e.stored.get(1)); e.render();
  e.select(created.id);
  assert.equal(e.get('CountryPanel').data.name, 'Renamed custom');
  assert.deepEqual(e.get('CountryPanel').data.geometry, created.geometry);
  assert.equal(e.get('Source').data.features.length, 2);
});

test('absorption between renamed countries uses IDs and keeps the target identity', async () => {
  const e = editor();
  const otherGeometry = { type: 'Polygon', coordinates: [[[2,0],[4,0],[4,2],[2,0]]] };
  const custom = { ...base, features: [base.features[0], { ...base.features[0], id: 'country-b', geometry: otherGeometry }] };
  await e.get('Sidebar').onImportCountries({ text: async () => JSON.stringify(custom) }); e.render();
  e.select(); e.get('CountryPanel').onChange({ name: 'Source', color: '#111111' }); e.render();
  e.select('country-b'); e.get('CountryPanel').onChange({ name: 'Target', color: '#222222' }); e.render();
  e.select(); e.get('CountryPanel').onStartAbsorb(); e.render();
  e.confirmations.push(true); e.select('country-b');
  assert.equal(e.confirmationMessages.at(-1), 'Absorb Source into Target?');
  const features = e.get('Source').data.features;
  assert.equal(features.length, 1);
  assert.equal(features[0].id, 'country-b');
  assert.equal(features[0].properties.name, 'Target');
  assert.equal(features[0].properties.customColor, '#222222');
  assert.notDeepEqual(features[0].geometry, otherGeometry);
});

test('loading a version 1 world migrates name-based edits before selection and saving', async () => {
  const e = editor();
  e.stored.set(9, { id: 9, name: 'Legacy', schema_version: 1, base_map: base,
    edits: { Original: { name: 'Legacy rename', color: '#123456' } },
  });
  e.get('Navbar').onMyWorlds(); e.render();
  await e.get('WorldsPanel').onLoad({ id: 9 }); e.render(); e.select();
  assert.equal(e.get('CountryPanel').data.name, 'Legacy rename');
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
  await e.get('Navbar').onSave(); e.render();
  assert.equal(e.calls[0].schema_version, 3);
  assert.deepEqual(Object.keys(e.calls[0].edits), ['country-a']);
});

test('subdivisions can be added, selected, edited, deleted, and saved', async () => {
  const e = editor();
  e.select();
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  e.get('CountryPanel').onStartSubdivision(); e.render();
  for (const [lng, lat] of [[0.2,0.2], [1,0.2], [1,1]]) {
    e.get('Map').onClick({ originalEvent: { detail: 1 }, features: [], lngLat: { lng, lat } }); e.render();
  }
  e.prompts.push('North');
  e.get('Map').onDblClick({ preventDefault() {}, features: [] }); e.render();
  const subdivision = e.getAll('Source').find(source => source.id === 'subdivisions').data.features[0];
  assert.ok(subdivision);
  assert.equal(subdivision.properties.parentTerritoryId, 'country-a');
  assert.equal(e.get('SubdivisionPanel').data.name, 'North');
  e.get('SubdivisionPanel').onChange({ name: 'Northwest', color: '#0891b2' }); e.render();
  e.prompts.push('Subdivided'); await e.get('Navbar').onSave(); e.render();
  assert.equal(e.calls[0].schema_version, 3);
  const subdivisionId = Object.keys(e.calls[0].subdivisions)[0];
  assert.equal(e.calls[0].subdivisions[subdivisionId].parent_id, 'country-a');
  assert.equal(e.calls[0].subdivisions[subdivisionId].name, 'Northwest');
  assert.equal(e.calls[0].subdivisions[subdivisionId].color, '#0891b2');
  e.confirmations.push(true);
  e.get('SubdivisionPanel').onDeleteSubdivision(); e.render();
  assert.equal(e.getAll('Source').some(source => source.id === 'subdivisions'), false);
});

test('deleting a country removes its subdivisions', async () => {
  const e = editor();
  e.select();
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  e.get('CountryPanel').onStartSubdivision(); e.render();
  for (const [lng, lat] of [[0.2,0.2], [1,0.2], [1,1]]) {
    e.get('Map').onClick({ originalEvent: { detail: 1 }, features: [], lngLat: { lng, lat } }); e.render();
  }
  e.prompts.push('North');
  e.get('Map').onDblClick({ preventDefault() {}, features: [] }); e.render();
  e.get('SubdivisionPanel').onClose(); e.render();
  e.select();
  e.confirmations.push(true);
  e.get('CountryPanel').onDeleteCountry(); e.render();
  assert.equal(e.getAll('Source').some(source => source.id === 'subdivisions'), false);
  e.prompts.push('Cascade'); await e.get('Navbar').onSave(); e.render();
  assert.deepEqual(e.calls[0].subdivisions, {});
  assert.equal(e.calls[0].edits['country-a'].geometry, null);
});

const firstRegion = [[0.5,0.1], [1.5,0.1], [1.5,0.4], [0.5,0.4]];
const secondRegion = [[1,0.1], [1.8,0.1], [1.8,0.5], [1,0.5]];
function drawSubdivision(e, points, name) {
  e.get('SubdivisionPanel')?.onClose(); e.render();
  if (!e.get('CountryPanel')?.isAddingSubdivision) {
    e.select();
    if (!e.get('CountryPanel').showSubdivisions) {
      e.get('CountryPanel').onToggleSubdivisions(); e.render();
    }
    e.get('CountryPanel').onStartSubdivision(); e.render();
  }
  for (const [lng, lat] of points) {
    e.get('Map').onClick({ originalEvent: { detail: 1 }, features: [], lngLat: { lng, lat } }); e.render();
  }
  if (name) e.prompts.push(name);
  e.get('Map').onDblClick({ preventDefault() {}, features: [] }); e.render();
}
const visibleSubdivisions = e => e.getAll('Source').find(s => s.id === 'subdivisions')?.data.features ?? [];
const subdivisionIntersection = e => turf.intersect(turf.featureCollection(visibleSubdivisions(e)));

test('overlapping OFF trims sibling subdivisions and saves the resulting boundaries', async () => {
  const e = editor();
  drawSubdivision(e, firstRegion, 'First');
  const originalArea = turf.area(visibleSubdivisions(e)[0]);
  drawSubdivision(e, secondRegion, 'Second');
  assert.equal(visibleSubdivisions(e).length, 2);
  assert.equal(subdivisionIntersection(e), null);
  assert.ok(turf.area(visibleSubdivisions(e)[0]) < originalArea);
  e.prompts.push('Trimmed'); await e.get('Navbar').onSave(); e.render();
  const savedFeatures = Object.values(e.calls[0].subdivisions).map(s => turf.feature(s.geometry));
  assert.equal(turf.intersect(turf.featureCollection(savedFeatures)), null);
});

test('overlapping ON permits intersections and switching OFF resolves existing ones', () => {
  const e = editor();
  e.get('Navbar').onToggleOverlapping(); e.render();
  drawSubdivision(e, firstRegion, 'First');
  drawSubdivision(e, secondRegion, 'Second');
  assert.ok(subdivisionIntersection(e));
  e.get('Navbar').onToggleOverlapping(); e.render();
  assert.equal(e.get('Navbar').allowOverlapping, false);
  assert.equal(subdivisionIntersection(e), null);
});

test('complete subdivision absorption can be cancelled without changing saved boundaries', () => {
  const e = editor();
  drawSubdivision(e, firstRegion, 'First');
  const before = visibleSubdivisions(e);
  e.confirmations.push(false);
  drawSubdivision(e, firstRegion);
  assert.deepEqual(visibleSubdivisions(e), before);
  assert.equal(e.get('CountryPanel').isAddingSubdivision, true);
  e.confirmations.push(true); e.prompts.push('Replacement');
  e.get('Map').onDblClick({ preventDefault() {}, features: [] }); e.render();
  assert.equal(visibleSubdivisions(e).length, 1);
  assert.equal(visibleSubdivisions(e)[0].properties.name, 'Replacement');
});

test('cancelling absorption when switching OFF preserves the ON setting and both subdivisions', () => {
  const e = editor();
  e.get('Navbar').onToggleOverlapping(); e.render();
  drawSubdivision(e, firstRegion, 'First');
  drawSubdivision(e, firstRegion, 'Second');
  const before = visibleSubdivisions(e);
  e.confirmations.push(false);
  e.get('Navbar').onToggleOverlapping(); e.render();
  assert.equal(e.get('Navbar').allowOverlapping, true);
  assert.deepEqual(visibleSubdivisions(e), before);
  e.confirmations.push(true);
  e.get('Navbar').onToggleOverlapping(); e.render();
  assert.equal(e.get('Navbar').allowOverlapping, false);
  assert.equal(visibleSubdivisions(e).length, 1);
  assert.equal(visibleSubdivisions(e)[0].properties.name, 'Second');
});

test('a rejected outside subdivision clears its preview and vertices and allows a fresh drawing', async () => {
  const e = editor();
  drawSubdivision(e, [[10,10], [11,10], [11,11]]);
  assert.match(e.notices.at(-1), /outside the selected country/);
  assert.equal(e.get('CountryPanel').isAddingSubdivision, true);
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
  assert.equal(e.getAll('Source').some(s => s.id === 'new-country'), false);
  assert.equal(e.getAll('Layer').some(l => l.id === 'new-vertices-layer'), false);
  drawSubdivision(e, firstRegion, 'Valid');
  assert.equal(visibleSubdivisions(e).length, 1);
  e.prompts.push('Recovered'); assert.equal(await e.get('Navbar').onSave(), true);
});

test('subdivision visibility is opt-in per selected country and does not alter saved data', async () => {
  const e = editor();
  const region = { parent_id: 'country-a', name: 'Region', color: '#123456', geometry };
  const otherCountry = { ...base.features[0], id: 'country-b' };
  e.stored.set(10, {
    id: 10, name: 'Visibility', schema_version: 3, edits: {},
    base_map: { ...base, features: [...base.features, otherCountry] },
    subdivisions: { region, other: { ...region, parent_id: 'country-b' } },
  });
  e.get('Navbar').onMyWorlds(); e.render();
  await e.get('WorldsPanel').onLoad({ id: 10 }); e.render();
  assert.equal(visibleSubdivisions(e).length, 0);
  e.select();
  assert.equal(e.get('CountryPanel').showSubdivisions, false);
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  assert.deepEqual(visibleSubdivisions(e).map(f => f.id), ['region']);
  e.get('Map').onClick({ originalEvent: { detail: 1 }, features: visibleSubdivisions(e) }); e.render();
  assert.equal(e.get('SubdivisionPanel').data.name, 'Region');
  e.get('SubdivisionPanel').onClose(); e.render();
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  assert.equal(visibleSubdivisions(e).length, 0);
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  e.select('country-b');
  assert.equal(visibleSubdivisions(e).length, 0);
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  assert.deepEqual(visibleSubdivisions(e).map(f => f.id), ['other']);
  e.get('CountryPanel').onClose(); e.render();
  assert.equal(visibleSubdivisions(e).length, 0);
  e.select('country-b');
  assert.equal(e.get('CountryPanel').showSubdivisions, false);
  assert.equal(e.get('Navbar').hasUnsavedChanges, false);
  await e.get('Navbar').onSave(); e.render();
  assert.equal(Object.keys(e.calls[0].subdivisions).length, 2);
});

test('creating a subdivision while hidden keeps visibility off until explicitly enabled', () => {
  const e = editor(); e.select();
  e.get('CountryPanel').onStartSubdivision(); e.render();
  for (const [lng, lat] of firstRegion) {
    e.get('Map').onClick({ originalEvent: { detail: 1 }, features: [], lngLat: { lng, lat } }); e.render();
  }
  e.prompts.push('Hidden');
  e.get('Map').onDblClick({ preventDefault() {}, features: [] }); e.render();
  assert.equal(e.get('CountryPanel').subdivisionCount, 1);
  assert.equal(e.get('CountryPanel').showSubdivisions, false);
  assert.equal(visibleSubdivisions(e).length, 0);
  e.get('CountryPanel').onToggleSubdivisions(); e.render();
  assert.equal(visibleSubdivisions(e)[0].properties.name, 'Hidden');
});
