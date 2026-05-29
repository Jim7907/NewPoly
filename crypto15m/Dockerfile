FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

CMD ["node", "server/index.js"]
