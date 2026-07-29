import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

const createProductSchema = z
  .object({
    sku: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    priceCents: z.number().int().nonnegative(),
    stock: z.number().int().nonnegative().default(0),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const search = request.nextUrl.searchParams;
    const data = await salonRepository.listProducts({
      query: search.get("query")?.trim() || undefined,
      lowStockAt: search.has("lowStockAt") ? Number(search.get("lowStockAt")) : undefined,
      skip: Math.max(0, Number(search.get("offset") ?? 0)),
      take: Math.min(100, Math.max(1, Number(search.get("limit") ?? 50))),
    });
    return NextResponse.json({ data });
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
    const input = createProductSchema.parse(await request.json());
    const product = await salonRepository.createProduct(input);
    return NextResponse.json(
      { data: await salonRepository.findProductById(product.id) },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CREATE_FAILED" },
      { status: 400 },
    );
  }
}
