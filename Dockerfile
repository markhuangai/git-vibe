FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/git-vibe-setup/package.json ./packages/git-vibe-setup/package.json
RUN corepack pnpm install --frozen-lockfile

COPY . .
RUN corepack pnpm build:app
RUN CI=true corepack pnpm prune --prod --ignore-scripts

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/app ./dist/app
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/app ./app

EXPOSE 3000

CMD ["node", "dist/app/server.js"]
