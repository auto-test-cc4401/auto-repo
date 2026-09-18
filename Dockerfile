# Pinning the runtime is the whole point: v1 broke because the Node it was
# written against removed a syntax it depended on.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --include=dev typescript && npx tsc -p tsconfig.json && npm prune --omit=dev

ENTRYPOINT ["node", "dist/cli/index.js"]
