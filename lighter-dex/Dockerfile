# Build the static site (Vite reads .env at build time), then serve it with nginx.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
# postinstall downloads + checksum-verifies Lighter's WASM signer into public/signer/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
