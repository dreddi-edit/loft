import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

const schema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().max(30).optional(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
    marketingOptIn: z.boolean().default(false),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const search = request.nextUrl.searchParams;
    const customers = await salonRepository.listCustomers({
      query: search.get("query")?.trim() || undefined,
      skip: Math.max(0, Number(search.get("offset") ?? 0)),
      take: Math.min(100, Math.max(1, Number(search.get("limit") ?? 50))),
    });
    return NextResponse.json({ data: customers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const input = schema.parse(await request.json());
    const customer = await salonRepository.createCustomer(input);
    return NextResponse.json({ data: customer }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CREATE_FAILED" },
      { status: 400 },
    );
  }
}
