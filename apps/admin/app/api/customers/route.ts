import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@hair-simo/db";
import { assertRole } from "../../../lib/auth";

export async function GET(request: NextRequest) {
  try {
    assertRole(request, ["owner", "manager", "staff"]);
    const customers = await prisma.customer.findMany({
      include: { appointments: true, notes: true, consents: true },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ data: customers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}
