# ── build stage: full deps (incl. Vite) → dist/ ──
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund && test -x node_modules/.bin/vite
COPY . .
RUN npm run build && test -f dist/index.html

# ── runtime stage: production deps only ──
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && test -d node_modules/express
COPY --from=build /app/dist ./dist
COPY server ./server
COPY docs ./docs
EXPOSE 3003
CMD ["node", "server/index.js"]
