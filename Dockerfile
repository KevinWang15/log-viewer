FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production \
    PORT=5178 \
    LOG_ROOT=/logs \
    STREAM_MAX_ENTRIES=100000 \
    STREAM_MAX_BYTES=33554432 \
    STREAM_MAX_SOURCES=16 \
    STREAM_IDLE_TTL_SECONDS=3600 \
    STREAM_MAX_PAYLOAD_BYTES=2097152
RUN mkdir -p /logs && chown node:node /logs
COPY --chown=node:node --from=build /app/server/dist server/dist
COPY --chown=node:node --from=build /app/web/dist web/dist
COPY --chown=node:node --from=build /app/server/package.json server/
COPY --chown=node:node --from=build /app/node_modules node_modules
EXPOSE 5178
VOLUME ["/logs"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:5178/healthz || exit 1
USER node
WORKDIR /app/server
CMD ["node", "dist/index.js"]
