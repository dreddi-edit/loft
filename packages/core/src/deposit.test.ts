import { describe, expect, it } from "vitest";

import { BookingEngine, buildAvailabilitySlots, calculateDeposit, calculateTotalPrice } from "./index";

describe("calculateDeposit", () => {
  it("caps values above 100 percent", () => {
    const result = calculateDeposit({ amountCents: 5000, currency: "EUR" }, 120);
    expect(result.amountCents).toBe(5000);
  });

  it("floors values below 0 percent", () => {
    const result = calculateDeposit({ amountCents: 5000, currency: "EUR" }, -30);
    expect(result.amountCents).toBe(0);
  });
});

describe("calculateTotalPrice", () => {
  it("adds addons onto base price", () => {
    const total = calculateTotalPrice(5000, [1000, 300]);
    expect(total.amountCents).toBe(6300);
  });
});

describe("buildAvailabilitySlots", () => {
  it("skips blocked intervals", () => {
    const slots = buildAvailabilitySlots({
      serviceDurationMin: 60,
      bufferAfterMin: 10,
      intervalMin: 30,
      dayStart: new Date("2026-07-29T09:00:00.000Z"),
      dayEnd: new Date("2026-07-29T12:00:00.000Z"),
      blocked: [
        {
          startsAt: new Date("2026-07-29T09:30:00.000Z"),
          endsAt: new Date("2026-07-29T10:45:00.000Z"),
        },
      ],
    });
    expect(slots.length).toBe(1);
    expect(slots[0]?.startsAt.toISOString()).toBe("2026-07-29T11:00:00.000Z");
  });
});

describe("BookingEngine", () => {
  it("creates, reschedules and cancels an appointment", () => {
    const engine = new BookingEngine();
    const created = engine.create({
      customerId: "c1",
      serviceId: "s1",
      startsAt: new Date("2026-07-29T09:00:00.000Z"),
      endsAt: new Date("2026-07-29T10:00:00.000Z"),
      staffId: "st1",
      locale: "de",
    });
    expect(created.id).toBe("apt_1");

    const moved = engine.reschedule(
      created.id,
      new Date("2026-07-29T10:00:00.000Z"),
      new Date("2026-07-29T11:00:00.000Z"),
    );
    expect(moved.status).toBe("confirmed");

    const cancelled = engine.cancel(created.id, "customer request");
    expect(cancelled.status).toBe("cancelled");
  });
});
