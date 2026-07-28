import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../../lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const body = await request.json();
    if (body.note) {
      await salonRepository.addCustomerNote(id, String(body.note));
    }
    const customerFields = { ...body };
    delete customerFields.note;
    const customer = Object.keys(customerFields).length
      ? await salonRepository.updateCustomer(id, customerFields)
      : await salonRepository.findCustomerById(id);
    return NextResponse.json({ data: customer });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UPDATE_FAILED" }, { status: 400 });
  }
}
