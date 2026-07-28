import { NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";

export async function GET() {
  const staff = await salonRepository.listStaff();
  return NextResponse.json({
    data: staff
      .filter((member) => member.isBookable)
      .map((member) => ({ id: member.id, displayName: member.displayName })),
  });
}
