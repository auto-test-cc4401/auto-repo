# Pinning the runtime keeps behaviour stable between semesters, when the tool
# may go months without being run.
FROM node:22-bookworm-slim AS build

# better-sqlite3 compiles a native binding at install time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Uses the pnpm version pinned in package.json "packageManager".
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# --frozen-lockfile fails rather than resolving new versions. Dependency
# lifecycle scripts remain blocked except for pnpm.onlyBuiltDependencies.
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

ENTRYPOINT ["node", "dist/cli/index.js"]
