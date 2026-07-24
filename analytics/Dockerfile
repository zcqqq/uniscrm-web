FROM node:20-slim

RUN npm install -g wrangler

WORKDIR /app
COPY server.js server-parse.cjs ./

EXPOSE 8080
CMD ["node", "server.js"]
