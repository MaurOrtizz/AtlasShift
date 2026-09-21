# AtlasShift

**Redraw borders. Reshape worlds.**

AtlasShift is an interactive political map editor for building alternate worlds. Starting from a world map, you can reshape national borders, create new countries, merge territories, and give every nation its own name and color. It is designed for alternate-history scenarios, fictional geopolitics, role-playing campaigns, and anyone who wants to explore how a different map could change a world.

The project combines visual editing with real geographic operations. Borders are represented as GeoJSON, while polygon unions, intersections, differences, and sea clipping are calculated directly in the browser. A FastAPI backend stores named worlds in a local SQLite database so they can be revisited and refined.

> **Project status:** AtlasShift is under active development. Core territory editing and complete world snapshots are available, with regression tests for persistence and API failures. Country subdivisions are on the roadmap.

## Features

- **Redraw borders:** move, insert, and remove territory vertices directly on the map.
- **Create countries:** draw a polygon, assign a name, and choose a custom color.
- **Expand and merge territories:** add land to a country or absorb one nation into another.
- **Control overlaps:** allow overlapping territories or automatically trim affected countries. AtlasShift asks for confirmation before a country is completely absorbed.
- **Keep territories out of the sea:** new polygons are clipped against features identified as sea in the loaded dataset.
- **Manage multiple worlds:** save, load, and delete scenarios from the **My Worlds** panel.
- **Exchange geographic data:** import GeoJSON feature collections and export the resulting country geometries.

## Technology stack

| Layer | Technologies | Responsibility |
| --- | --- | --- |
| User interface | React, TypeScript, and Vite | Editing tools, panels, and map state. |
| Mapping | MapLibre GL, react-map-gl, and Turf.js | Map rendering and geometric operations. |
| API | Python and FastAPI | Creating, reading, updating, and deleting worlds. |
| Persistence | SQLModel and SQLite | Storing world names and territory edits. |
| Development and CI | Docker Compose and GitHub Actions | Local containers, validation, and image builds. |

## Run with Docker

You need Docker with Compose and an internet connection to download dependencies and load external map resources. Clone or download this repository, then run the following command from its root directory:

```sh
docker compose up --build
```

When both services are ready:

- Open AtlasShift at [http://localhost:5173](http://localhost:5173).
- Check the API at [http://localhost:8000](http://localhost:8000).
- Explore and test the endpoints through [http://localhost:8000/docs](http://localhost:8000/docs).

This Compose setup is intended for development and includes automatic reloads. Worlds are stored in `server/atlasshift.db`, inside the server directory mounted into the container, so they remain available after the containers stop. Run `docker compose down` from the repository root to stop the environment.

## Local installation

The local setup requires **Python 3.12**, **Node.js 22.13 or later in the Node 22 line, or Node.js 24+**, and npm. Run the backend and frontend in separate terminals.

### 1. Backend

Create a virtual environment and install the Python dependencies from the repository root.

**Windows / PowerShell:**

```powershell
py -3.12 -m venv venv
.\venv\Scripts\python.exe -m pip install -r server/requirements.txt
cd server
..\venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

**macOS / Linux:**

```sh
python3.12 -m venv venv
./venv/bin/python -m pip install -r server/requirements.txt
cd server
../venv/bin/python -m uvicorn main:app --reload --port 8000
```

Starting the server from `server/` makes SQLite use `server/atlasshift.db`. The database and its tables are created automatically when the API starts.

Existing databases receive an additive migration on startup to store complete project snapshots. Existing rows are preserved. Version 1 worlds include the base map (including sea features), edits, background metadata, and overlap settings. Legacy worlds still load against the bundled default map; previously missing custom base maps or geometries cannot be reconstructed automatically. Back up an existing database before upgrading.

### 2. Frontend

In another terminal, run these commands from the repository root:

```sh
cd atlasshift
npm ci
```

Create an `.env` file inside `atlasshift/` with the following value:

```dotenv
VITE_API_URL=http://localhost:8000
```

Then start the editor from the `atlasshift/` directory:

```sh
npm run dev -- --port 5173 --strictPort
```

Open [http://localhost:5173](http://localhost:5173). The backend currently allows that origin through CORS. If you change the frontend host or port, update `allow_origins` in `server/main.py`. Restart Vite after changing `.env`.

## Create your first world

1. **Select a country** with a single click. Use the side panel to rename it or choose a color; leave the color picker to apply the new color.
2. Select **Edit Borders → Edit Vertices**. Drag a point to move the border, click a border segment to insert a point, or right-click a vertex to remove it. Select **Done** when finished.
3. To add territory to the selected country, use **Edit Borders → Draw Territory**, place the polygon points, and select **Done** once the shape has at least three points.
4. To create a country, select **Add Polygon** from the toolbar, place at least three points, and double-click to finish. Enter a unique country name when prompted.
5. To merge countries, select the country that will be absorbed, choose **Absorb Into...**, click the receiving country, and confirm the operation.
6. Finish any active territory edit, then select **Save** and name the world. It can then be opened from **My Worlds**. Unsaved work is checked before importing or switching worlds; cancelling or failing a save stops that action. Closing the tab also warns about pending changes.
7. Use **Export Countries GeoJSON** to download `countries.geojson`. **Import Countries GeoJSON** accepts a GeoJSON `FeatureCollection`; country features should use `Polygon` or `MultiPolygon` geometries and unique names in `properties.name`.

The **Allow Overlapping** switch controls whether countries may cover the same area. When it is disabled, a new border can trim neighboring countries, so inspect the result before saving.

## Repository structure

```text
.
├── atlasshift/                 # React web application
│   ├── src/components/         # Navigation bar and editor panels
│   ├── src/data/               # GeoJSON maps and base-map style
│   ├── src/App.tsx             # Territory editing and interactions
│   ├── src/api.ts              # Backend HTTP client
│   ├── Dockerfile              # Production build served by Nginx
│   └── Dockerfile.dev          # Vite development server
├── server/
│   ├── main.py                 # FastAPI endpoints
│   ├── database.py             # World model and SQLite connection
│   ├── requirements.txt        # Python dependencies
│   └── Dockerfile              # Backend image
├── .github/workflows/docker.yml
└── docker-compose.yml          # Complete development environment
```

## Commands and API

Run the frontend commands from `atlasshift/`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run lint` | Check the source code with ESLint. |
| `npm test` | Run frontend regression tests using Node's built-in test runner. |
| `npm run build` | Type-check the project and create a production build in `dist/`. |
| `npm run preview` | Serve the production build locally; this does not start the backend. |

The API exposes `GET /worlds`, `GET /worlds/{id}`, `POST /worlds`, `PUT /worlds/{id}`, and `DELETE /worlds/{id}`. Version 1 create and update requests contain `name`, `edits`, `schema_version: 1`, and a GeoJSON `base_map`; optional fields store background metadata and overlap settings. In an edit, an omitted `geometry` preserves the base geometry, while `geometry: null` explicitly deletes the country. Legacy payloads can still create legacy worlds, but cannot overwrite version 1 worlds. With the server running, use the [interactive FastAPI documentation](http://localhost:8000/docs) to inspect and test these operations.

Run backend tests from the repository root with the Python interpreter from your virtual environment:

```sh
python -m unittest discover -s server -p "test_*.py" -v
```

The backend tests use isolated in-memory databases, including a legacy-schema migration test; they do not change saved worlds. Frontend tests cover editor state transitions, save cancellation, concurrent edits, HTTP failures, project round trips, and GeoJSON validation.

GitHub Actions runs both test suites, lints and builds the frontend, and builds both Docker images. Pushes to `main` publish the `atlasshift-frontend` and `atlasshift-backend` images to GHCR. To build the production frontend image manually, provide the API URL through the `VITE_API_URL` build argument; Vite embeds this value during compilation.

## Current limitations

- **Custom backgrounds:** project snapshots preserve background metadata, but `/uploads/background-image` is not implemented yet. The upload control is disabled until file storage is available.
- **Legacy worlds:** old saves may already contain lost geometries or lack their imported base map. Compatibility preserves their stored data without guessing which deletions were accidental.
- **GeoJSON exchange:** export includes committed country geometries, names, colors, and sea features, but not world-level settings or background resources. Complete snapshots are stored through **Save**.
- **External base map:** the current style uses MapTiler resources and contains a sample key. For reliable use, configure your own key in `atlasshift/src/data/BlankWorldMap.json` or replace the source with another compatible provider.
- **Local use:** the API has no authentication or per-user world separation. The included environment is designed for local development and demonstrations.

## Roadmap

Future versions of AtlasShift are planned to support country subdivisions such as states, provinces, regions, and departments. This will include creating and editing internal borders, assigning subdivision names and colors, and managing them independently while preserving their relationship with the parent country.

Other planned improvements include stronger project persistence, complete custom-background support, and undo/redo tools for safer scenario exploration.
