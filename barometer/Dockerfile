FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3004
EXPOSE 3004

CMD ["node", "server/index.js"]
