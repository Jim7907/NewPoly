FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY index.html vite.config.js ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps
COPY server/ ./server/
COPY --from=builder /app/build ./build
RUN mkdir -p /app/data /app/logs
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data
EXPOSE 3001
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD wget -qO- http://localhost:3001/api/health || exit 1
CMD ["node", "server/index.js"]
