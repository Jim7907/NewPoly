FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3003
EXPOSE 3003

CMD ["node", "server/index.js"]
