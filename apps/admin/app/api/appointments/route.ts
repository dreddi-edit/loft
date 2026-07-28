import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { assertRole } from "../../../lib/auth";

export async function GET(request: NextRequest) {
  try {
    assertRole(request, ["owner", "manager", "staff"]);
    const appointments = await salonRepository.listAppointments();
    return NextResponse.json({ data: appointments });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}
