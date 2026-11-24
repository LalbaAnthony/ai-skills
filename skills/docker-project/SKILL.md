---
name: docker-project
description: Docker Compose conventions for projects that run as services (web apps, APIs, workers). One root docker-compose.yml with dev and prod profiles; a Dockerfile.dev and a Dockerfile.prod per source-built service, run by <service>-dev and <service>-prod services; hot reload in dev; multi-stage, non-root prod images on pinned tags; variables from a single .env, hardcoded or `${VAR}` but never with a fallback such as `${VAR:-default}`, all listed in .env.example; cron jobs inside a container, never on the host; a README whose first 20 lines hold the one command that starts the project. Use when creating a web app, API or worker, dockerizing a project, writing or reviewing a Dockerfile, docker-compose.yml, .dockerignore or .env.example, adding a service, database, queue worker, scheduler or cron job, or writing a README quick start. New setups follow every rule; in an existing Docker setup, new code follows the rules and existing violations are flagged, never fixed unasked.
license: MIT
compatibility: Docker Engine with Docker Compose v2.22 or later (profiles, develop.watch).
---

# Docker project

A rule set for projects that run as services, orchestrated by Docker Compose in development and in production. It covers the Compose file, the Dockerfiles, environment variables, scheduled jobs and the README quick start. Per-stack examples are in `references/`.

## Which mode applies

- **When to dockerize**: a new project gets a Docker setup when it runs as a service: web app, API, worker, or anything that needs a database, cache or queue. Libraries, CLIs and content repositories get none unless the user asks.
- **New setup**: the project has no Compose file and no Dockerfile, and the agent creates the Docker setup, for a new project or for an existing codebase being dockerized. Every rule applies to the files the agent creates, README quick start included.
- **Existing setup**: a Compose file or a Dockerfile exists. Follow "Existing setups".

## Rules

### Compose file

- **One Compose file, `docker-compose.yml`, at the project root.** No `compose.yaml`, `compose.yml` or `docker-compose.yaml`, no environment-specific file (`docker-compose.prod.yml`), no `-f` stacking.
- **One exception, `docker-compose.override.yml`**: gitignored, for machine-specific tweaks (a published database port, another host port). Compose loads it automatically. The project never depends on it, and it follows the same rules.
- **Top-level `name:`** set to the project name, hardcoded. **No `version:` key**: it is obsolete in the Compose specification and current Compose warns about it.
- **Two profiles, `dev` and `prod`, and every service declares `profiles:`.** `docker compose up` without a profile starts nothing, so the environment is always chosen explicitly.

### Services and profiles

| Service | Dockerfiles | Compose services | Profiles |
| --- | --- | --- | --- |
| Built from the project's source | `Dockerfile.dev` and `Dockerfile.prod` | `<service>-dev`, `<service>-prod` | `[dev]`, `[prod]` |
| Custom image needed in one environment only | `Dockerfile.dev` and `Dockerfile.prod`, one of them minimal | `<service>-dev`, `<service>-prod` | `[dev]`, `[prod]` |
| Custom image identical in dev and prod (official image plus an extension or init script baked in) | one `Dockerfile` | `<service>` | `[dev, prod]` |
| Official image used as is (database, cache, broker) | none: `image:` | `<service>` | `[dev, prod]` |
| Same, when dev and prod need a different configuration | none: `image:` | `<service>-dev`, `<service>-prod` | `[dev]`, `[prod]` |
| Dev-only tool (mail catcher, database admin UI, frontend dev server on an official image) | none: `image:` | `<service>` | `[dev]` |
| Worker or scheduler running the app's code | the app's pair, with its own `command:` | `<worker>-dev`, `<worker>-prod` | `[dev]`, `[prod]` |

- **The dev/prod split applies only when relevant**: only the first two rows get a pair. An official image used as is never gets a Dockerfile. A shared infrastructure service splits into `-dev` and `-prod` only when a difference is actually needed, such as a port published in dev.
- **Common configuration of a pair** goes in an extension field with an anchor (`x-app: &app`), merged into both variants with `<<: *app`. A merge key does not merge deeply: a key the variant redefines replaces the anchored one entirely. Write `environment:` in mapping form and anchor it separately (`environment: &app-env`), so a variant can add to it with `<<: *app-env`.
- **One name for both variants**: give `<service>-dev` and `<service>-prod` the same network alias (`aliases: [app]`), so other services and configuration files address `app` whatever the profile. Only one profile runs at a time, so the alias never resolves to two containers. Never put the alias in an anchor that workers also merge: they would answer to the same name and receive the app's traffic.

### Dockerfiles

- **A pair is two files**, `Dockerfile.dev` and `Dockerfile.prod`. Never a plain `Dockerfile` next to them, and never one Dockerfile with dev and prod stages selected by `target:`.
- **Location, next to the source**: a single source-built service has its pair at the root, with `.` as build context. With several, each has its pair in its own folder (`./api/Dockerfile.dev`), with that folder as build context. A service with no source tree of its own (nginx in front of a PHP app, a database with an init script) has its Dockerfiles in `./docker/<service>/`, with the build context its build needs (`context: .`, `dockerfile: docker/nginx/Dockerfile.prod`).
- **One `.dockerignore` per build context**, shared by both Dockerfiles. It excludes at least `.git`, `.env*`, dependency folders (`node_modules`, `vendor`), build output and local artifacts.
- **`Dockerfile.dev` is tuned for iteration**: dev dependencies and debug tooling, unminified output, the dev server or watcher as the command (`npm run dev`, `vite`), no production build step. One stage is enough. It may run as root.
- **`Dockerfile.prod` is tuned for running**: multi-stage, with build tools and dev dependencies only in builder stages. The runtime stage holds the built artifacts and production dependencies only (`npm ci --omit=dev`, `composer install --no-dev`), minified assets, production mode (`NODE_ENV=production`, `php.ini-production`, opcache), and no debugger, watcher, test or source file it does not need. It runs as a non-root `USER`.
- **Base images**: the official image, or the vendor's own when it is the maintained non-root variant (`nginxinc/nginx-unprivileged`), on its slim or alpine variant when it has one. Alpine's musl libc breaks some native dependencies; use the Debian `-slim` variant then.
- **Pinned to the release line**: the major version (`node:24-alpine`, `postgres:17-alpine`, `redis:7-alpine`), or major.minor for images whose minors are release lines with breaking changes (`php:8.4-fpm-alpine`, `nginx:1.28-alpine`). Never `latest` or an untagged image, in `FROM` or in `image:`. `# syntax=docker/dockerfile:1` follows the same rule.
- **Cache-friendly layers**: copy the dependency manifest and lockfile, install, then copy the source. Package manager caches go in BuildKit cache mounts (`RUN --mount=type=cache,target=/root/.npm npm ci`).
- **Exec form** for `CMD` and `ENTRYPOINT`: `CMD ["node", "dist/index.js"]`. When a shell is needed, `["sh", "-c", "... && exec <process>"]`, so the process replaces the shell. Entrypoint scripts end with `exec "$@"`.
- **No secrets in images**: never in `ARG`, `ENV` or a copied file. Secrets reach containers at runtime, through `environment:`. Build arguments are for public values only (a frontend's public API URL).
- **Logs go to stdout and stderr**: no log file inside the container and no volume for logs.

### Environment variables

- **No fallback in Docker files.** In `docker-compose.yml`, `docker-compose.override.yml` and every `Dockerfile*`, a value is either hardcoded or read from the environment, never read with a fallback:

  | Allowed | Banned |
  | --- | --- |
  | `PORT: 3000` | `PORT: ${PORT:-3000}`, `${PORT-3000}` |
  | `PORT: ${PORT}`, `$PORT` | `${PORT:+...}`, `${PORT+...}` |
  | `ARG NODE_VERSION=24` (a hardcoded build argument default) | `${PORT:?message}`, `${PORT?message}` |
  | `ENV NODE_ENV=production` | `ENV LOG_LEVEL=${LOG_LEVEL:-info}`, `${...:-...}` in `RUN` |
  | | `command: ["sh", "-c", "serve --port $${PORT:-3000}"]`: an escaped fallback, applied by the container's shell |

  Entrypoint scripts and application code are outside this rule.
- **Compose interpolates the whole file, whatever the active profile.** A variable used only by a prod service must be set in dev too; unset, it becomes an empty string with a warning.
- **Variables passed explicitly**: each service lists what it receives under `environment:`, in mapping form (`PORT: ${PORT}`), renamed where the image expects another name (`POSTGRES_PASSWORD: ${DB_PASSWORD}`). No `env_file:`, which hands every variable to every service that declares it.
- **One `.env`, at the root, gitignored**, holding every variable of the Compose file, for dev and prod alike. The production host has its own `.env`.
- **`.env.example`, committed and in sync**: every variable referenced in the Compose file has an entry, and every entry is referenced. Values are working dev values, so that a fresh clone starts after `cp .env.example .env`; prod-only values get non-secret placeholders. Update it in the same change as the Compose file.
- **`.gitignore`** lists `.env` and `docker-compose.override.yml`.

### Prod images

- Prod services have both `build:` and `image: ${IMAGE_REGISTRY}/<project>-<service>:${IMAGE_TAG}`. CI builds and pushes (`docker compose --profile prod build`, then `push`), and the production host pulls and starts (`docker compose --profile prod pull`, then `up -d`) without building. Dev services have no `image:`.

### Hot reload

- **Every dev variant of a source-built service reloads on file change.** Pick the mechanism per stack and say why:
  - **Compose `develop.watch`**: `sync` the source into the container, `sync+restart` for configuration files, `rebuild` on a change to the lockfile or `Dockerfile.dev`. Files are written inside the container, so the language's watcher (`node --watch`, `tsx watch`, Vite) gets native file events, with no polling on Windows or macOS hosts. One-way only: files generated in the container never reach the host. The image must contain the source, because `sync` only sends changes. Started with `up --watch`.
  - **Bind mount** of the source: two-way, so code generators run in the container (`php artisan make:*`) write to the host, and interpreted code that is read on each request (PHP) needs no watcher. File events from Windows or macOS hosts may need polling. On Linux hosts, files created in a root container belong to root.

### Runtime

- **Healthchecks** on every service that serves traffic or that another service depends on, infrastructure included. Dependents wait with the long `depends_on` syntax and `condition: service_healthy`. The healthcheck command must exist in the image: alpine images have `wget` (BusyBox), slim images often have neither `curl` nor `wget`.
- **Named volumes** for persistent data (databases, uploads), declared under the top-level `volumes:`. Bind mounts are only for the dev source and dev configuration.
- **Published ports**: in prod, only the public entry point (the app or its reverse proxy) is published. An infrastructure service that runs in prod publishes nothing; split it into `-dev` and `-prod` when dev needs its port, or publish it in a personal override file.
- **`restart: unless-stopped`** on every service of the `prod` profile, shared infrastructure included. Dev variants and dev-only tools have none.
- **`init: true`** on services that run the project's code (app, workers, scheduler, dev servers), so signals reach the process and zombies are reaped.

### Scheduled jobs

- **Scheduled jobs run inside a container, never on the host**: no host crontab, systemd timer, launchd job or Task Scheduler task, and no README or deploy step that installs one. Inside a container, any scheduler is fine: the framework's (`php artisan schedule:work`, Symfony Scheduler, node-cron), supercronic, or the system's crond.
- **In the main service by default**, when the scheduler runs inside the main process itself (node-cron in the API process).
- **Otherwise, in a dedicated service** (`scheduler-dev`, `scheduler-prod`) built from the app's Dockerfiles with its own `command:`: when the main process is not a scheduler (php-fpm, an HTTP server without one). Never a process manager (supervisord, s6) or a process backgrounded by the entrypoint to run both in one container.
- An in-process scheduler runs every job once per replica. When the main service is scaled beyond one instance, move the scheduler to a dedicated service and say so.

### README quick start

The first 20 lines of `README.md` hold, in a fenced `bash` block, the one command that starts the dev environment: `docker compose --profile dev up --build`, plus `--watch` when a dev service uses `develop.watch`. The `.env` creation step (`cp .env.example .env`) sits right above that block, also within the first 20 lines.

````markdown
# shop

Online shop: REST API and storefront.

## Quick start

Requires Docker with Compose v2.22 or later. First run: `cp .env.example .env`.

```bash
docker compose --profile dev up --build --watch
```
````

## Example

A single source-built Node service with a database. Per-stack Dockerfiles and variants are in `references/`.

```yaml
name: shop

x-app: &app
  init: true
  environment: &app-env
    PORT: 3000
    DATABASE_URL: postgres://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}
  ports:
    - "${APP_PORT}:3000"
  depends_on:
    db:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:3000/health"]
    interval: 10s
    timeout: 3s
    retries: 5
  networks:
    default:
      aliases: [app]

services:
  app-dev:
    <<: *app
    profiles: [dev]
    build:
      context: .
      dockerfile: Dockerfile.dev
    environment:
      <<: *app-env
      LOG_LEVEL: debug
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
        - action: rebuild
          path: package-lock.json
        - action: rebuild
          path: Dockerfile.dev

  app-prod:
    <<: *app
    profiles: [prod]
    build:
      context: .
      dockerfile: Dockerfile.prod
    image: ${IMAGE_REGISTRY}/shop-app:${IMAGE_TAG}
    restart: unless-stopped

  db:
    image: postgres:17-alpine
    profiles: [dev, prod]
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \"$${POSTGRES_USER}\" -d \"$${POSTGRES_DB}\""]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  db-data:
```

```dotenv
# .env.example: working dev values; the production host has its own .env
APP_PORT=3000
DB_USER=shop
DB_PASSWORD=shop
DB_NAME=shop
IMAGE_REGISTRY=registry.example.com
IMAGE_TAG=local
```

## New setups

1. Check that the project runs as a service (see "Which mode applies"). Otherwise, do not add Docker unless the user asks.
2. List the services and classify each with the table in "Services and profiles". Decide where scheduled jobs run, and the hot reload mechanism of each source-built service.
3. Write the Dockerfiles and one `.dockerignore` per build context. Start from the matching reference: `references/node-api.md`, `references/laravel.md`, `references/vite-frontend.md`. For another stack, apply the same rules.
4. Write `docker-compose.yml`, then `.env.example`, a `.env` copied from it, and the `.gitignore` entries.
5. Write the README quick start in the first 20 lines: in a new README, after the title and a one-line description; in an existing README, insert it there without rewriting the rest.
6. Verify, and fix anything reported:
   - `docker compose --env-file .env.example config --variables`: every row has `REQUIRED` false and empty `DEFAULT VALUE` and `ALTERNATE VALUE` (a fallback appears in those columns), and every `.env.example` key is listed.
   - `docker compose --env-file .env.example --profile dev --profile prod config --quiet`: no "variable is not set" warning.
   - Search `docker-compose*.yml` and every `Dockerfile*` for the regular expression `\$\{[A-Za-z_][A-Za-z0-9_]*:?[-+?]`: it finds the fallbacks the commands above cannot see, in Dockerfiles and escaped as `$${...}`. Every match is a violation.
   - When Docker can build images: `docker compose --profile prod build`, then `docker compose --profile dev up --build` (plus `--watch`) until every service is healthy, a source change reaches the running app, and `docker compose --profile dev down`.

## Existing setups

1. **At the start of the first Docker task**, check the project-level items: Compose file name and count, profiles and service variants, Dockerfile pairs and locations, fallbacks (the commands of "New setups", step 6), `.env.example` sync, `.gitignore`, the README quick start, and scheduled jobs on the host (crontab lines in the README or in deploy scripts). Report the deviations once.
2. **New or changed code follows the rules** wherever it fits alongside the existing setup: a new source-built service gets its pair and both variants, a new variable is read as `${VAR}` and added to `.env.example`, a new scheduled job runs in a container.
3. **Project-level changes are flagged, never made unasked**: renaming `compose.yaml`, merging environment-specific Compose files, splitting a `Dockerfile` into a pair, introducing profiles, moving host cron jobs into a container, rewriting the README.
4. **Existing violations stay as they are.** When a requested change touches one, make the change in place and flag it: a variable added next to existing `${X:-y}` lines is written `${NEW}`, and the existing lines keep their fallback.
5. **Flag violations in the files read or edited during the task.** A full audit of the project happens only on request.
6. **Report** in a section at the end of the reply, grouped by rule, one `path:line` per violation with its concrete fix:

```markdown
## docker-project violations

### Fallback in a Docker file
- `docker-compose.yml:14`: `${PORT:-3000}`. Write `${PORT}` and add `PORT=3000` to .env.example.

### Missing Dockerfile pair
- `api/Dockerfile`: one Dockerfile for dev and prod. Split it into api/Dockerfile.dev and api/Dockerfile.prod, run by api-dev and api-prod.

### Scheduled job on the host
- `README.md:42`: asks to add `php artisan schedule:run` to the host crontab. Run `php artisan schedule:work` in a scheduler-dev / scheduler-prod service.
```
