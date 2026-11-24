# Laravel

A Laravel app on php-fpm behind nginx, with a queue worker, the scheduler, MySQL, and Vite for assets. Versions and PHP extensions are examples: use the release lines and extensions the project needs.

## Services

| Service | Image | Profiles | Role |
| --- | --- | --- | --- |
| `app-dev`, `app-prod` | `./Dockerfile.dev`, `./Dockerfile.prod` | `[dev]`, `[prod]` | php-fpm, network alias `app` |
| `queue-dev`, `queue-prod` | the app's pair | `[dev]`, `[prod]` | `queue:listen` in dev (reloads code), `queue:work` in prod |
| `scheduler-dev`, `scheduler-prod` | the app's pair | `[dev]`, `[prod]` | `schedule:work`: php-fpm is not a scheduler, so a dedicated service |
| `web-dev`, `web-prod` | `./docker/nginx/Dockerfile.dev`, `Dockerfile.prod` | `[dev]`, `[prod]` | nginx: the only published port |
| `vite` | `node:24-alpine` as is | `[dev]` | Vite dev server for hot module replacement |
| `db` | `mysql:8.4` as is | `[dev, prod]` | database |

nginx is a pair although its dev image only adds a configuration file: its prod image bakes in the built `public/`.

## Layout

```
.
├── .dockerignore
├── .env.example
├── Dockerfile.dev
├── Dockerfile.prod
├── docker/
│   └── nginx/
│       ├── Dockerfile.dev
│       ├── Dockerfile.prod
│       └── default.conf
├── docker-compose.yml
├── app/, bootstrap/, config/, public/, resources/, routes/, storage/, ...
├── composer.json, composer.lock
└── package.json, package-lock.json
```

## Hot reload: bind mount

The project folder is bind-mounted into the dev containers. PHP reads the code on each request, so no watcher is needed; `queue:listen` starts a fresh process per job and `schedule:work` runs `schedule:run` in a new process every minute, so both pick up changes too. The mount is two-way: files written by `php artisan make:*`, `composer` or `npm` in a container land in the project. On Linux hosts they belong to root, since dev images run as root.

The root `.env` is visible to Laravel through the mount. The variables Compose passes take precedence, since Laravel never overwrites a variable already set in the environment. The prod image contains no `.env` (`.dockerignore`): Laravel reads the environment only.

## Dockerfile.dev

```dockerfile
# syntax=docker/dockerfile:1
FROM php:8.4-fpm-alpine
RUN apk add --no-cache git unzip \
 && docker-php-ext-install pdo_mysql \
 && mv "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini"
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
CMD ["sh", "-c", "composer install && exec php-fpm"]
```

The source comes from the bind mount. `composer install` runs at startup so that a fresh clone starts with the README one-liner. The workers override `command:` and wait for `app-dev` to be healthy, so they never run Composer concurrently. Add Xdebug here (`pecl install xdebug`) when the project uses it; never in `Dockerfile.prod`.

## Dockerfile.prod

```dockerfile
# syntax=docker/dockerfile:1
FROM php:8.4-fpm-alpine AS base
RUN docker-php-ext-install pdo_mysql opcache

FROM base AS vendor
RUN apk add --no-cache git unzip
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
ENV COMPOSER_CACHE_DIR=/tmp/composer-cache
WORKDIR /app
COPY composer.json composer.lock ./
RUN --mount=type=cache,target=/tmp/composer-cache \
    composer install --no-dev --no-scripts --no-autoloader --prefer-dist
COPY . .
RUN composer dump-autoload --optimize --no-dev

FROM node:24-alpine AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
COPY --from=vendor /app/vendor ./vendor
RUN npm run build

FROM base
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
WORKDIR /var/www/html
COPY --from=vendor /app ./
COPY --from=assets /app/public/build ./public/build
RUN chown -R www-data:www-data storage bootstrap/cache
USER www-data
CMD ["sh", "-c", "php artisan optimize && exec php-fpm"]
```

- `composer dump-autoload` runs the `post-autoload-dump` scripts, so `package:discover` writes `bootstrap/cache/packages.php` into the image.
- `php artisan optimize` caches the configuration at startup, not at build time: at build time it would bake the build environment into the image.
- The `assets` stage copies `vendor/` because Laravel's default `resources/css/app.css` makes Tailwind scan Blade views under `vendor/`.
- The app needs `public/build/manifest.json` for the `@vite` directive, and nginx needs the files themselves: both prod Dockerfiles build the assets. Keep the two `assets` stages identical.
- Running php-fpm as `www-data` logs a notice that the pool's `user` directive is ignored; it is harmless.

## docker/nginx

`default.conf`, shared by both nginx images. `app` is the alias of `app-dev` and `app-prod`:

```nginx
server {
    listen 8080;
    root /var/www/html/public;
    index index.php;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_pass app:9000;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include fastcgi_params;
    }
}
```

`docker/nginx/Dockerfile.dev` (`public/` is bind-mounted read-only):

```dockerfile
FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
```

`docker/nginx/Dockerfile.prod`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=assets /app/public /var/www/html/public
```

If the CSS scans `vendor/` (see above), this `assets` stage needs the Composer dependencies too: add the `vendor` stage of the app's `Dockerfile.prod`, or drop that `@source` line from `app.css`.

The nginx-unprivileged image runs as a non-root user and listens on 8080.

## .dockerignore

```
.git
.env*
vendor
node_modules
public/build
public/hot
bootstrap/cache/*.php
tests
docker-compose*.yml
Dockerfile.*
```

`docker/` stays in the context: the nginx images copy their configuration from it.

## Compose

```yaml
name: shop

x-app: &app
  init: true
  environment: &app-env
    APP_KEY: ${APP_KEY}
    APP_URL: ${APP_URL}
    LOG_CHANNEL: stderr
    DB_CONNECTION: mysql
    DB_HOST: db
    DB_PORT: 3306
    DB_DATABASE: ${DB_DATABASE}
    DB_USERNAME: ${DB_USERNAME}
    DB_PASSWORD: ${DB_PASSWORD}
    QUEUE_CONNECTION: database
  depends_on:
    db:
      condition: service_healthy

x-app-dev: &app-dev
  <<: *app
  profiles: [dev]
  build:
    context: .
    dockerfile: Dockerfile.dev
  environment:
    <<: *app-env
    APP_ENV: local
    APP_DEBUG: "true"
  volumes:
    - .:/var/www/html

x-app-prod: &app-prod
  <<: *app
  profiles: [prod]
  build:
    context: .
    dockerfile: Dockerfile.prod
  image: ${IMAGE_REGISTRY}/shop-app:${IMAGE_TAG}
  restart: unless-stopped
  environment:
    <<: *app-env
    APP_ENV: production
    APP_DEBUG: "false"

x-fpm-healthcheck: &fpm-healthcheck
  test: ["CMD", "php", "-r", "exit(@fsockopen('127.0.0.1', 9000) ? 0 : 1);"]
  interval: 10s
  timeout: 3s
  retries: 5
  start_period: 120s

x-web: &web
  ports:
    - "${APP_PORT}:8080"
  healthcheck:
    test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/up"]
    interval: 10s
    timeout: 3s
    retries: 5

services:
  app-dev:
    <<: *app-dev
    healthcheck: *fpm-healthcheck
    networks:
      default:
        aliases: [app]

  app-prod:
    <<: *app-prod
    healthcheck: *fpm-healthcheck
    networks:
      default:
        aliases: [app]

  queue-dev:
    <<: *app-dev
    command: ["php", "artisan", "queue:listen", "--tries=3"]
    depends_on:
      app-dev:
        condition: service_healthy

  queue-prod:
    <<: *app-prod
    command: ["php", "artisan", "queue:work", "--tries=3"]
    depends_on:
      app-prod:
        condition: service_healthy

  scheduler-dev:
    <<: *app-dev
    command: ["php", "artisan", "schedule:work"]
    depends_on:
      app-dev:
        condition: service_healthy

  scheduler-prod:
    <<: *app-prod
    command: ["php", "artisan", "schedule:work"]
    depends_on:
      app-prod:
        condition: service_healthy

  web-dev:
    <<: *web
    profiles: [dev]
    build:
      context: .
      dockerfile: docker/nginx/Dockerfile.dev
    volumes:
      - ./public:/var/www/html/public:ro
    depends_on:
      app-dev:
        condition: service_healthy

  web-prod:
    <<: *web
    profiles: [prod]
    build:
      context: .
      dockerfile: docker/nginx/Dockerfile.prod
    image: ${IMAGE_REGISTRY}/shop-web:${IMAGE_TAG}
    restart: unless-stopped
    depends_on:
      app-prod:
        condition: service_healthy

  vite:
    image: node:24-alpine
    profiles: [dev]
    init: true
    working_dir: /app
    command: ["sh", "-c", "npm install && exec npm run dev"]
    volumes:
      - .:/app
    ports:
      - "5173:5173"

  db:
    image: mysql:8.4
    profiles: [dev, prod]
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ${DB_DATABASE}
      MYSQL_USER: ${DB_USERNAME}
      MYSQL_PASSWORD: ${DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  db-data:
```

- The workers redefine `depends_on`, which replaces the anchor's: they wait for the app, which waits for the database.
- `/up` is Laravel's health route (`health: '/up'` in `bootstrap/app.php`). The web healthcheck goes through nginx, php-fpm and Laravel.
- The Vite dev server must listen on all interfaces and point the browser at the published port: in `vite.config.js`, `server: { host: '0.0.0.0', port: 5173, strictPort: true, hmr: { host: 'localhost' } }`.
- Migrations are not run at startup: `docker compose --profile dev exec app-dev php artisan migrate` in dev, a deploy step in prod.

Started with `docker compose --profile dev up --build` (no `--watch`: nothing uses `develop.watch`).

## .env.example

```dotenv
APP_PORT=8000
APP_URL=http://localhost:8000
APP_KEY=base64:<dev key>
DB_DATABASE=shop
DB_USERNAME=shop
DB_PASSWORD=shop
DB_ROOT_PASSWORD=root
IMAGE_REGISTRY=registry.example.com
IMAGE_TAG=local
```

`APP_KEY` gets a dev key, generated once (`php artisan key:generate --show`) and committed in `.env.example` so that a fresh clone works; the production `.env` has its own.
