# Lila Multiplayer Tic-Tac-Toe

A production-style submission for the Lila backend assignment: a multiplayer Tic-Tac-Toe game with a responsive React frontend and server-authoritative Nakama backend.

## What is included

- Responsive web client built with React + TypeScript.
- Server-authoritative Tic-Tac-Toe rules in the Nakama TypeScript runtime.
- Room creation, room discovery, and automatic matchmaking.
- Graceful disconnect handling with reconnect windows.
- Classic and timed modes.
- Persistent player stats and a global leaderboard.
- Docker-based local stack and deployment scaffolding.

## Project structure

- `frontend/`: public web application.
- `nakama/`: authoritative match runtime, Docker image, and local config.
- `docker-compose.yml`: local CockroachDB + Nakama stack.
- `render.yaml`: deployment blueprint example for the frontend and backend.

## Frontend setup

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

The frontend expects these variables:

- `VITE_NAKAMA_HOST`
- `VITE_NAKAMA_PORT`
- `VITE_NAKAMA_SERVER_KEY`
- `VITE_NAKAMA_USE_SSL`

## Backend setup

```bash
cd nakama
npm install
npm run build
```

This compiles the Nakama runtime bundle into `nakama/build/index.js`.

## Local multiplayer run

Docker is required for local backend execution.

```bash
docker compose up --build
```

Once the stack is running:

- Nakama API: `http://127.0.0.1:7350`
- Nakama Console: `http://127.0.0.1:7351`
- CockroachDB Admin UI: `http://127.0.0.1:8080`

Recommended frontend `.env` values for local development:

```bash
VITE_NAKAMA_HOST=127.0.0.1
VITE_NAKAMA_PORT=7350
VITE_NAKAMA_SERVER_KEY=defaultkey
VITE_NAKAMA_USE_SSL=false
```

## Game flow

1. The player authenticates with Nakama from the web client.
2. The player can create a room, quick-match, or join an open room.
3. All move validation happens inside the authoritative Nakama match handler.
4. The server broadcasts board updates, turn changes, wins, draws, reconnect states, and timeouts.
5. Results are persisted to storage and written to the global leaderboard.

## Architecture decisions

- The backend is server-authoritative to prevent client-side move tampering.
- Match labels are used to expose room discovery for open rooms.
- Timed mode is enforced server-side using authoritative deadlines.
- Disconnects are handled with a reconnect grace window before forfeit.
- Player stats are stored per-user in Nakama storage and summarized in a leaderboard.

## Multiplayer testing guide

1. Start the backend with Docker.
2. Start the frontend with `npm run dev`.
3. Open the app in two browsers or one browser plus an incognito window.
4. Create or discover a room from one client.
5. Join from the other client, then verify:
   - turn order stays authoritative,
   - invalid duplicate moves are rejected,
   - state updates arrive in real time,
   - timed mode forfeits on timeout,
   - disconnects trigger reconnect handling.

## Deployment process

### Frontend

The frontend is ready for static hosting on Vercel, Netlify, or GitHub Pages. A GitHub Pages workflow is included in `.github/workflows/frontend-pages.yml`.

### Backend

The backend is containerized through `nakama/Dockerfile`. Deploy it together with CockroachDB on a provider that supports long-running services such as Render, Railway, Fly.io, DigitalOcean Apps, or Heroic Cloud.

### Recommended production steps

1. Provision CockroachDB.
2. Build and deploy the `nakama/` Docker image.
3. Set the frontend environment variables to the public Nakama hostname and protocol.
4. Deploy the static frontend.

## Deliverables checklist

- Source code repository: prepared in this workspace.
- Public web app: frontend ready for static deployment.
- Nakama server endpoint: backend containerized and documented.
- README: setup, architecture, deployment, configuration, and testing included.

## Environment note

This machine did not include Docker, GitHub CLI, or hosting credentials, so the repository has been prepared for publish/deploy, but the final remote push and cloud rollout still require authenticated access to GitHub and a hosting provider.

