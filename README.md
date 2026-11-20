# pulsus-dash
Modern Enterprise Monitoring Dashboard for PromQL, LogQL, TraceQL, and ProfileQL

## Run the client

The web client is in `client/` (TypeScript, React and Vite). With Node.js 24 (see `client/.nvmrc`):

```sh
cd client && npm ci && npm run dev
```

The dev server runs on `http://localhost:5173` with an in-repo stub API, so no backend is needed.
See [`docs/client/README.md`](docs/client/README.md) for the layout, configuration and checks.
