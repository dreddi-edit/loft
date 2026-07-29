import { NextRequest, NextResponse } from "next/server";
import { hashPassword, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

const createStaffSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(150),
    bio: z.string().trim().max(2000).optional(),
    phone: z.string().trim().max(30).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    isBookable: z.boolean().default(true),
    role: z.enum(["owner", "manager", "staff"]).default("staff"),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const search = request.nextUrl.searchParams;
    const staff = await salonRepository.listStaff({
      query: search.get("query")?.trim() || undefined,
      isBookable: search.has("isBookable") ? search.get("isBookable") === "true" : undefined,
      skip: Math.max(0, Number(search.get("offset") ?? 0)),
      take: Math.min(100, Math.max(1, Number(search.get("limit") ?? 50))),
    });
    return NextResponse.json({ data: staff });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const input = createStaffSchema.parse(await request.json());
    const staff = await salonRepository.createStaff({
      ...input,
      passwordHash: await hashPassword(input.password),
    });
    return NextResponse.json({ data: staff }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CREATE_FAILED" },
      { status: 400 },
    );
  }
}
