import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

export const reportQuerySchema = z
  .object({
    from: z.string().refine((value) => !Number.isNaN(Date.parse(value))).optional(),
    to: z.string().refine((value) => !Number.isNaN(Date.parse(value))).optional(),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .strict()
  .refine(
    (input) => !input.from || !input.to || new Date(input.to) >= new Date(input.from),
    "INVALID_DATE_RANGE",
  );

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const input = reportQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const report = await salonRepository.getReportStats(
      input.from ? new Date(input.from) : undefined,
      input.to ? new Date(input.to) : undefined,
    );
    if (input.format === "csv") {
      const headers = Object.keys(report);
      const values = Object.values(report).map((value) => {
        const text = value === null ? "" : String(value);
        return `"${text.replaceAll('"', '""')}"`;
      });
      return new NextResponse(`${headers.join(",")}\n${values.join(",")}\n`, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="hair-simo-report.csv"',
        },
      });
    }
    return NextResponse.json({ data: report });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "REPORT_FAILED" },
      { status: 400 },
    );
  }
}
