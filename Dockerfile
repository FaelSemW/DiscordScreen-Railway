# Multi-stage production build for Discord Screen Railway
FROM node:22-slim AS build

WORKDIR /app

COPY package.json ./
COPY client/package.json client/
COPY server/package.json server/

RUN npm install

COPY client/ client/
COPY server/ server/
COPY shared/ shared/

RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
COPY client/package.json client/
COPY server/package.json server/

RUN npm install --omit=dev && npm cache clean --force

COPY server/ server/
COPY shared/ shared/
COPY --from=build /app/client/dist client/dist

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
