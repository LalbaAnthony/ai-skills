# Vite frontend

A frontend bundled by Vite (React, Vue, Svelte, vanilla): the Vite dev server in dev, the static build served by nginx in prod. Shown next to a Node API (`references/node-api.md`) whose variants have the network alias `api`. Versions are examples.

## Layout

```
.
├── .env.example
├── docker-compose.yml
├── api/
└── web/
    ├── .dockerignore
    ├── Dockerfile.dev
    ├── Dockerfile.prod
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── package-lock.json
    ├── public/
    ├── src/
    └── vite.config.ts
```

`nginx.conf` belongs to the web service, so it sits next to its Dockerfiles, in the build context.

## Hot reload: develop.watch

`develop.watch` syncs the source into the container, where Vite's watcher gets native file events and pushes changes to the browser over HMR. A bind mount from a Windows or macOS host would need `server.watch.usePolling`. Vite restarts itself when `vite.config.ts` changes, so a `sync` is enough for it. A change to the lockfile or `Dockerfile.dev` rebuilds the image.

The dev server listens on all interfaces and proxies API calls to the `api` alias:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://api:3000' },
  },
});
```

Port 5173 is published as `"5173:5173"`: the HMR client connects to the dev server's port, so keep the same number on both sides, or set `server.hmr.clientPort` to the published port.

## Dockerfile.dev

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
```

## Dockerfile.prod

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
```

The runtime image holds only nginx and the minified bundle: no Node, no `node_modules`, no source.

`nginx.conf`, for an API that serves its routes under `/api`, and client-side routing:

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;

    location /api/ {
        proxy_pass http://api:3000;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

nginx resolves `api` when it starts, so `web-prod` waits for `api-prod` to be healthy.

### Build-time values

Vite inlines `import.meta.env.VITE_*` into the bundle at build time, so a value the prod bundle needs is a build argument: `ARG VITE_SENTRY_DSN` in the `build` stage, before `RUN npm run build`, and `args: { VITE_SENTRY_DSN: ${VITE_SENTRY_DSN} }` under `build:` in `web-prod`. It ends up in public JavaScript: public values only, never a secret. In dev, pass it under `environment:` of `web-dev`; Vite reads `VITE_*` variables from the process environment.

## .dockerignore

```
.env*
node_modules
dist
coverage
Dockerfile.*
```

## Compose

```yaml
x-web: &web
  networks:
    default:
      aliases: [web]

services:
  web-dev:
    <<: *web
    profiles: [dev]
    init: true
    build:
      context: ./web
      dockerfile: Dockerfile.dev
    ports:
      - "5173:5173"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:5173/"]
      interval: 10s
      timeout: 3s
      retries: 5
    develop:
      watch:
        - action: sync
          path: ./web/src
          target: /app/src
        - action: sync
          path: ./web/public
          target: /app/public
        - action: sync
          path: ./web/index.html
          target: /app/index.html
        - action: sync
          path: ./web/vite.config.ts
          target: /app/vite.config.ts
        - action: rebuild
          path: ./web/package-lock.json
        - action: rebuild
          path: ./web/Dockerfile.dev

  web-prod:
    <<: *web
    profiles: [prod]
    build:
      context: ./web
      dockerfile: Dockerfile.prod
    image: ${IMAGE_REGISTRY}/shop-web:${IMAGE_TAG}
    restart: unless-stopped
    ports:
      - "${WEB_PORT}:8080"
    depends_on:
      api-prod:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/"]
      interval: 10s
      timeout: 3s
      retries: 5
```

In prod, nginx is the public entry point: `api-prod` publishes no port, and the browser reaches the API through `/api`. In dev, `api-dev` may publish its port for direct calls.

Started with `docker compose --profile dev up --build --watch`.
