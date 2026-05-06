FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --frozen-lockfile

COPY . .
RUN corepack pnpm build
RUN corepack pnpm prune --prod --ignore-scripts

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/app ./app
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/schemas ./schemas

EXPOSE 3000

CMD ["node", "dist/app/server.js"]
