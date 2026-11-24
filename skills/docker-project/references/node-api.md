# Node API

A backend run by Node (Express, Fastify, NestJS, plain `node:http`), in TypeScript or JavaScript. Versions are examples: use the release line the project targets (`engines.node`).

## Layout

```
.
├── .dockerignore
├── .env.example
├── Dockerfile.dev
├── Dockerfile.prod
├── docker-compose.yml
├── package.json
├── package-lock.json
└── src/
```

In a repository with several services, the same files sit in `./api/`, which is the build context, and the `develop.watch` paths are relative to the Compose file (`./api/src`).

## Hot reload: develop.watch

`develop.watch` syncs `src/` into the container, and the `dev` script restarts the process on change: `node --watch src/index.js`, or `tsx watch src/index.ts` for TypeScript (tsx resolves the `.js` specifiers of relative imports to `.ts` files, which Node's own type stripping does not). A bind mount would need polling on Windows and macOS hosts to see changes, and nothing needs to flow back from the container to the host. A change to the lockfile or `Dockerfile.dev` rebuilds the image.

## Dockerfile.dev

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
```

`COPY . .` is required with `develop.watch`: `sync` only sends changed files, so the image must start with the whole source.

## Dockerfile.prod

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
```

- `package.json` is copied into the runtime stage because Node reads its `"type"` field to load ES modules.
- The files stay owned by root: the `node` user can read the code but not modify it.
- Without a build step (plain JavaScript), drop the `build` stage and copy `src/` instead of `dist/`.
- Native addons that fail to build on alpine (musl) need `node:24-slim` in every stage; it has the same `node` user. Slim images have no `wget`: write the healthcheck with Node itself, `["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]`.

## .dockerignore

```
.git
.env*
node_modules
dist
coverage
*.log
docker-compose*.yml
Dockerfile.*
```

## Compose

The example in `SKILL.md` ("Example") is this stack: `app-dev` and `app-prod` sharing an `x-app` anchor, a shared `db`, `develop.watch` on `app-dev`. Started with `docker compose --profile dev up --build --watch`.

## Scheduled jobs

node-cron (or another in-process scheduler) runs in the main process, so it stays in `app-dev` and `app-prod`: no dedicated service. When `app-prod` runs more than one replica, every job runs once per replica: move the jobs to a `scheduler` entry point (`src/scheduler.ts`) run by `scheduler-dev` and `scheduler-prod`, built from the same Dockerfiles with `command: ["node", "--enable-source-maps", "dist/scheduler.js"]` in prod and the watcher on that entry point in dev.
