FROM node:20-alpine

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js database.js ./
COPY public/ ./public/

RUN mkdir -p /app/data /app/uploads

EXPOSE 3000

CMD ["node", "server.js"]
