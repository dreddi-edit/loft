import { NextResponse } from "next/server";
import { getPublicRuntimeConfig } from "../../../../lib/public-config";

export async function GET() {
  return NextResponse.json({ data: getPublicRuntimeConfig() });
}
