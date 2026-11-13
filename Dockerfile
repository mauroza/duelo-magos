# syntax=docker/dockerfile:1.7
# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && cp -r src/infra/migrations dist/infra/migrations
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
RUN apk upgrade --no-cache && apk add --no-cache tini
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node client ./client
# Usuario sin privilegios (no root).
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "--import", "./dist/observability/instrument.js", "dist/main.js"]
