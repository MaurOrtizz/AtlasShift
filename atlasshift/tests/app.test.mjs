import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as world from '../src/world.ts';

const require = createRequire(import.meta.url);
const geometry = { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,0]]] };
const base = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Original' }, geometry }] };
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
    confirm: message => { const value = confirmations.shift(); assert.notEqual(value, undefined, message); return value; },
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
  function select() {
    get('Map').onClick({ originalEvent: { detail: 1 }, features: [{ properties: { name: 'Original' }, layer: { id: 'countries-fill' } }] });
    render();
  }
  render();
  return { render, get, select, api, calls, stored, prompts, confirmations, notices, listeners };
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
  assert.equal(Object.hasOwn(e.calls[0].edits.Original, 'geometry'), false);
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
  assert.equal(e.calls[0].edits.Original.name, 'Original');
  assert.equal(e.calls[0].edits.Original.color, '#dcdcdc');
  assert.notDeepEqual(e.calls[0].edits.Original.geometry, geometry);
});
