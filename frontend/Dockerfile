# syntax=docker/dockerfile:1

# ---- build the static dashboard ---------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Dependencies first, so this layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- serve it, and forward API calls to the backend -------------------------
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80
