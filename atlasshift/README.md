# AtlasShift Frontend

This directory contains the web interface for AtlasShift, an interactive political map editor for building alternate worlds. It uses React and TypeScript for the interface, MapLibre GL to render the map, and Turf.js to modify territory geometries.

The editor lets users customize countries, redraw borders, create or absorb territories, and import or export GeoJSON. The **My Worlds** panel communicates with the FastAPI backend to manage saved scenarios.

See the [main README](../README.md) for the complete project overview, backend setup, Docker instructions, usage guide, limitations, and roadmap.

## Development

You need Node.js 22.13 or later in the Node 22 line, or Node.js 24+, npm, and the backend running at `http://localhost:8000`.

From this directory, install the dependencies:

```sh
npm ci
```

Create an `.env` file containing:

```dotenv
VITE_API_URL=http://localhost:8000
```

Start the editor:

```sh
npm run dev -- --port 5173 --strictPort
```

Open [http://localhost:5173](http://localhost:5173). Restart the development server after changing environment variables.

## Commands

- `npm run lint` checks the source code with ESLint.
- `npm test` runs regression tests for editor state, persistence, GeoJSON exchange, and HTTP errors using Node's built-in test runner.
- `npm run build` type-checks the project and creates a production build in `dist/`.
- `npm run preview` serves the production build locally. The backend must be started separately, and CORS must allow the preview origin.

For production, define `VITE_API_URL` before compiling. The included `Dockerfile` accepts it as a build argument and serves the generated files through Nginx.
