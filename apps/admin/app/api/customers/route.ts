import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const customers = await salonRepository.listCustomers();
    return NextResponse.json({ data: customers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const body = await request.json();
    const customer = await salonRepository.createCustomer({
      email: body.email ? String(body.email) : undefined,
      phone: body.phone ? String(body.phone) : undefined,
      firstName: String(body.firstName),
      lastName: String(body.lastName),
      locale: String(body.locale ?? "en"),
      sourceChannel: body.sourceChannel ?? "web",
      marketingOptIn: Boolean(body.marketingOptIn),
    });
    return NextResponse.json({ data: customer }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CREATE_FAILED" }, { status: 400 });
  }
}
