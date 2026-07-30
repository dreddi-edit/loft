import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  appointmentFindUnique,
  appointmentUpdate,
  paymentFindFirst,
  paymentCreate,
  paymentUpdate,
  balanceMock,
  redeemMock,
  confirmMock,
} = vi.hoisted(() => ({
  appointmentFindUnique: vi.fn(),
  appointmentUpdate: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  paymentUpdate: vi.fn(),
  balanceMock: vi.fn(),
  redeemMock: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },

  prisma: {
    appointment: {
      findUnique: appointmentFindUnique,
      update: appointmentUpdate,
    },
    payment: {
      findFirst: paymentFindFirst,
      create: paymentCreate,
      update: paymentUpdate,
    },
  },
}));

vi.mock("./booking-service", () => ({
  BookingService: class {
    confirm = confirmMock;
  },
}));

vi.mock("./voucher-service", () => ({
  VoucherService: class {
    balance = balanceMock;
    redeem = redeemMock;
  },
}));

import { PaymentService, resetPaymentWarnings } from "./payment-service";

const service = {
  slug: "colour",
  priceCents: 12_000,
};

const appointment = {
  id: "apt_1",
  status: "pending",
  depositRequired: true,
  service,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetPaymentWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  appointmentFindUnique.mockResolvedValue(appointment);
  appointmentUpdate.mockResolvedValue(appointment);
  paymentFindFirst.mockResolvedValue(null);
  paymentCreate.mockResolvedValue({
    id: "pay_1",
    amountCents: 3_600,
    tipCents: 0,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PaymentService.createCheckout", () => {
  it("redeems a voucher and reduces the card charge", async () => {
    balanceMock.mockResolvedValue({
      remainingCents: 1_500,
      currency: "EUR",
      status: "active",
    });
    redeemMock.mockResolvedValue({
      amountCents: 1_500,
      remainingCents: 500,
      currency: "EUR",
      idempotent: false,
    });

    const checkout = await new PaymentService().createCheckout({
      appointmentId: "apt_1",
      mode: "deposit",
      voucherCode: "3479ABCDFGHJ",
    });

    expect(redeemMock).toHaveBeenCalledWith("3479ABCDFGHJ", 1_500, {
      appointmentId: "apt_1",
      currency: "EUR",
    });
    expect(paymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountCents: 2_100,
          tipCents: 0,
        }),
      }),
    );
    expect(checkout.paymentRequired).toBe(true);
    expect(checkout.totalChargeCents).toBe(2_100);
  });

  it("confirms the appointment when a voucher covers the full charge", async () => {
    balanceMock.mockResolvedValue({
      remainingCents: 20_000,
      currency: "EUR",
      status: "active",
    });
    redeemMock.mockResolvedValue({
      amountCents: 3_600,
      remainingCents: 16_400,
      currency: "EUR",
      idempotent: false,
    });

    const checkout = await new PaymentService().createCheckout({
      appointmentId: "apt_1",
      mode: "deposit",
      voucherCode: "3479ABCDFGHJ",
    });

    expect(redeemMock).toHaveBeenCalledWith("3479ABCDFGHJ", 3_600, {
      appointmentId: "apt_1",
      currency: "EUR",
    });
    expect(confirmMock).toHaveBeenCalledWith("apt_1", "voucher payment");
    expect(paymentCreate).not.toHaveBeenCalled();
    expect(checkout).toMatchObject({
      paymentRequired: false,
      paymentId: null,
      totalChargeCents: 0,
    });
  });

  it("skips voucher redemption when no code is provided", async () => {
    await new PaymentService().createCheckout({
      appointmentId: "apt_1",
      mode: "deposit",
    });

    expect(balanceMock).not.toHaveBeenCalled();
    expect(redeemMock).not.toHaveBeenCalled();
    expect(paymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountCents: 3_600,
        }),
      }),
    );
  });
});
