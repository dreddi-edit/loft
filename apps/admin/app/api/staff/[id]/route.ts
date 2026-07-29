import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { requireSession } from "../../../../lib/auth";

const updateStaffSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    displayName: z.string().trim().min(1).max(150).optional(),
    bio: z.string().trim().max(2000).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
    active: z.boolean().optional(),
    isBookable: z.boolean().optional(),
    role: z.enum(["owner", "manager", "staff"]).optional(),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const data = await salonRepository.findStaffById(id);
    if (!data) return NextResponse.json({ error: "STAFF_NOT_FOUND" }, { status: 404 });
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
    const current = await salonRepository.findStaffById(id);
    if (!current) return NextResponse.json({ error: "STAFF_NOT_FOUND" }, { status: 404 });
    const input = updateStaffSchema.parse(await request.json());
    const roleKey = input.role;
    const userData = {
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };
    const profileData = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.isBookable !== undefined ? { isBookable: input.isBookable } : {}),
    };
    await Promise.all([
      Object.keys(userData).length
        ? salonRepository.updateStaffUser(current.userId, userData)
        : Promise.resolve(),
      Object.keys(profileData).length
        ? salonRepository.updateStaffProfile(id, profileData)
        : Promise.resolve(),
      roleKey
        ? prisma.$transaction(async (tx) => {
            const role = await tx.role.upsert({
              where: { key: roleKey },
              update: {},
              create: { key: roleKey },
            });
            await tx.userRole.deleteMany({ where: { userId: current.userId } });
            await tx.userRole.create({ data: { userId: current.userId, roleId: role.id } });
          })
        : Promise.resolve(),
    ]);
    return NextResponse.json({ data: await salonRepository.findStaffById(id) });
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
    const current = await salonRepository.findStaffById(id);
    if (!current) return NextResponse.json({ error: "STAFF_NOT_FOUND" }, { status: 404 });
    const deleted = await salonRepository.deleteStaff(id);
    if (!deleted) return NextResponse.json({ error: "STAFF_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ data: deleted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "DELETE_FAILED" },
      { status: 400 },
    );
  }
}
