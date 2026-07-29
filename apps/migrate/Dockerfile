FROM node:22-alpine
RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile --filter @hair-simo/db...

COPY packages/db ./packages/db
WORKDIR /app/packages/db
RUN pnpm exec prisma generate

CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
