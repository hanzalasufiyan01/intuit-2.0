# Intuit 2.0 — production image (multi-stage). NOT verified in this repository's development
# environment (no container runtime there): build and smoke-test it with `deploy/smoke.sh` before
# relying on it. See docs/operations.md.
#
#   docker build --target api -t intuit2-api .
#   docker build --target web -t intuit2-web .

FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @intuit-2/api build && pnpm --filter @intuit-2/web build
# Only the production dependencies of the API, with its compiled output.
RUN pnpm --filter @intuit-2/api deploy --legacy --prod /out/api

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production APP_ENV=production
WORKDIR /app
COPY --from=build /out/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
# The SQL migrations are read from src/database/migrations next to the compiled output.
COPY --from=build /repo/apps/api/src/database/migrations ./src/database/migrations
COPY --from=build /repo/apps/api/assets ./assets
COPY --from=build /repo/apps/api/package.json ./package.json
RUN useradd --system --uid 10001 --home /app intuit && mkdir -p /data/storage && chown -R intuit /data
USER intuit
ENV API_HOST=0.0.0.0 API_PORT=3000 STORAGE_LOCAL_ROOT=/data/storage
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
