FROM node:22-alpine AS base
# tzdata: alpine ships no zone database, so without it TZ=Europe/Rome silently
# resolves to UTC and every booking slot is off by the Italian UTC offset.
# openssl + libc6-compat: required by the Prisma musl query engine.
RUN apk add --no-cache libc6-compat openssl tzdata
ENV TZ=Europe/Rome
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/admin/package.json ./apps/admin/
COPY packages/ai/package.json ./packages/ai/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/gcp/package.json ./packages/gcp/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/ui/package.json ./packages/ui/
RUN pnpm install --frozen-lockfile

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# The whole /app tree is copied, not just the root node_modules: pnpm puts a
# node_modules directory (with the workspace symlinks and .bin) inside every package.
COPY --from=deps /app ./
COPY . .
# pnpm 10 skips dependency lifecycle scripts, so @prisma/client is installed without a
# generated client. Nothing that imports @hair-simo/db compiles until this has run.
RUN pnpm db:generate
# The `...` suffix builds every workspace dependency of @hair-simo/admin first.
RUN pnpm exec turbo run build --filter=@hair-simo/admin...

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/admin/public ./apps/admin/public

USER nextjs
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "apps/admin/server.js"]
