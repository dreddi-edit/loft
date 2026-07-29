import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../lib/auth";

export const customerUpdateSchema = z
  .object({
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
    marketingOptIn: z.boolean().optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const data = await salonRepository.findCustomerById(id);
    if (!data) return NextResponse.json({ error: "CUSTOMER_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const input = customerUpdateSchema.parse(await request.json());
    if (input.note) {
      await salonRepository.addCustomerNote(id, input.note);
    }
    const { note, ...customerFields } = input;
    void note;
    const customer = Object.keys(customerFields).length
      ? await salonRepository.updateCustomer(id, customerFields)
      : await salonRepository.findCustomerById(id);
    return NextResponse.json({ data: customer });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}
