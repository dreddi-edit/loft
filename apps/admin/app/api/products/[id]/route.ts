import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../lib/auth";

const schema = z
  .object({
    sku: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    priceCents: z.number().int().nonnegative().optional(),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const data = await salonRepository.findProductById(id);
    if (!data) return NextResponse.json({ error: "PRODUCT_NOT_FOUND" }, { status: 404 });
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
    await requireSession(request, ["owner", "manager"]);
    const { id } = await params;
    const input = schema.parse(await request.json());
    return NextResponse.json({ data: await salonRepository.updateProduct(id, input) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id } = await params;
    return NextResponse.json({ data: await salonRepository.deleteProduct(id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "DELETE_FAILED" },
      { status: 400 },
    );
  }
}
