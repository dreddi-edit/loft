import { CustomerHistoryService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import type { AuthSession } from "@hair-simo/core";
import { z } from "zod";
import { httpError } from "../../../../../lib/admin-api";

export const historyService = new CustomerHistoryService();

export const localeQuerySchema = z
  .object({
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
  })
  .strict();

export const customerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const noteKindSchema = z.enum(["general", "formula", "allergy", "preference"]);

export const addNoteSchema = z
  .object({
    note: z.string().trim().min(1).max(4_000),
    kind: noteKindSchema.optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const updateNoteSchema = z
  .object({
    note: z.string().trim().min(1).max(4_000).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const deleteNoteSchema = z
  .object({
    confirmAllergyDeletion: z.literal(true).optional(),
  })
  .strict();

export function parseCustomerId(rawId: string): string {
  const parsed = customerIdSchema.safeParse(rawId);
  if (!parsed.success) {
    throw httpError("VALIDATION_ERROR", {
      message: "The customer id is not valid.",
      logMessage: "malformed customer id in path",
    });
  }
  return parsed.data;
}

export function historyActor(session: AuthSession) {
  return { userId: session.userId, email: session.email, role: session.role };
}

export async function assertNoteBelongsToCustomer(customerId: string, noteId: string): Promise<void> {
  const row = await prisma.customerNote.findUnique({
    where: { id: noteId },
    select: { customerId: true },
  });
  if (!row || row.customerId !== customerId) {
    throw httpError("NOT_FOUND", {
      logMessage: `note ${noteId} not found for customer ${customerId}`,
    });
  }
}
