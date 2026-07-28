import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@hair-simo/db";
import { assertRole } from "../../../lib/auth";

export async function GET(request: NextRequest) {
  try {
    assertRole(request, ["owner", "manager", "staff"]);
    const staff = await prisma.staffProfile.findMany({
      include: { user: true, staffServices: { include: { service: true } } },
      orderBy: { displayName: "asc" },
    });
    return NextResponse.json({ data: staff });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}
