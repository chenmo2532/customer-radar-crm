FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=4173
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 4173
CMD ["node", "server.mjs"]
