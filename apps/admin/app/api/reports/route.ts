import { salonRepository } from "@hair-simo/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRoute } from "../../../lib/admin-api";

export const reportQuerySchema = z
  .object({
    from: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)))
      .optional(),
    to: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)))
      .optional(),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .strict()
  .refine((input) => !input.from || !input.to || new Date(input.to) >= new Date(input.from), {
    message: "to must not be before from",
    path: ["to"],
  });

export const GET = adminRoute<unknown, z.infer<typeof reportQuerySchema>>(
  { roles: ["owner", "manager"], route: "/api/reports", query: reportQuerySchema },
  async ({ query }) => {
    const report = await salonRepository.getReportStats(
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined,
    );
    if (query.format !== "csv") return { data: report };

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
  },
);
