FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
COPY scripts/only-pnpm.js scripts/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 1001 keygate \
  && useradd --system --uid 1001 --gid keygate keygate

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
COPY scripts/only-pnpm.js scripts/
RUN pnpm install --prod --frozen-lockfile \
  && pnpm store prune \
  && rm -rf scripts

COPY --from=build /app/dist ./dist

USER keygate

CMD ["node", "dist/index.js"]
