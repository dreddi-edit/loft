import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { currentTenantId, isTenantScopedModel } from "./tenant-context";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return false;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

if (!process.env.DATABASE_URL) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), "../../.env"),
    resolve(moduleDir, "../../../.env"),
  ]) {
    if (loadEnvFile(candidate)) break;
  }
}

const WHERE_INJECT_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

const DATA_INJECT_OPS = new Set(["create", "createMany"]);

function injectTenant(args: Record<string, unknown>, operation: string): Record<string, unknown> {
  const tenantId = currentTenantId();
  const next = { ...args };

  if (WHERE_INJECT_OPS.has(operation)) {
    const where = (next.where as Record<string, unknown> | undefined) ?? {};
    if (where.tenantId === undefined) {
      next.where = { ...where, tenantId };
    }
  }

  if (operation === "create") {
    const data = (next.data as Record<string, unknown> | undefined) ?? {};
    if (data.tenantId === undefined) {
      next.data = { ...data, tenantId };
    }
  }

  if (operation === "createMany") {
    const data = next.data;
    if (Array.isArray(data)) {
      next.data = data.map((row) =>
        row && typeof row === "object" && (row as { tenantId?: unknown }).tenantId === undefined
          ? { ...(row as object), tenantId }
          : row,
      );
    } else if (data && typeof data === "object" && (data as { tenantId?: unknown }).tenantId === undefined) {
      next.data = { ...(data as object), tenantId };
    }
  }

  if (operation === "upsert") {
    const create = (next.create as Record<string, unknown> | undefined) ?? {};
    if (create.tenantId === undefined) next.create = { ...create, tenantId };
  }

  return next;
}

function createClient() {
  const base = new PrismaClient({ log: ["warn", "error"] });
  return base.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (
            !isTenantScopedModel(model) ||
            (!WHERE_INJECT_OPS.has(operation) &&
              !DATA_INJECT_OPS.has(operation) &&
              operation !== "upsert")
          ) {
            return query(args);
          }
          return query(injectTenant(args as Record<string, unknown>, operation) as typeof args);
        },
      },
    },
  });
}

type AppPrisma = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrisma };

export const prisma: AppPrisma =
  globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
