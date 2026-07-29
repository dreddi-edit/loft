import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./repositories", () => ({
  salonRepository: {
    listStaff: vi.fn(),
    listBusinessHours: vi.fn(),
    listStaffAvailability: vi.fn(),
    listStaffTimeOff: vi.fn(),
    listBlockedAppointments: vi.fn(),
    findServiceBySlug: vi.fn(),
    findOrCreateCustomerByEmail: vi.fn(),
    updateCustomer: vi.fn(),
    recordConsent: vi.fn(),
    createAppointmentIfAvailable: vi.fn(),
    findAppointmentById: vi.fn(),
    rescheduleAppointmentIfAvailable: vi.fn(),
    updateAppointmentStatus: vi.fn(),
    listAppointmentsBetween: vi.fn(),
  },
}));

import {
  BookingService,
  MAX_BOOKING_HORIZON_DAYS,
  MIN_BOOKING_LEAD_MINUTES,
} from "./booking-service";
import { salonRepository } from "./repositories";
import { parseSalonDay, salonDayOfWeek, zonedMinutesToUtc } from "./time";

const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland"];
const originalHostZone = process.env.TZ;

const OPEN_MIN = 8 * 60;
const CLOSE_MIN = 17 * 60;
const MS_PER_DAY = 86_400_000;

const service = {
  id: "service-1",
  slug: "cut",
  durationMin: 60,
  bufferAfterMin: 15,
};
const staff = {
  id: "staff-1",
  isBookable: true,
  staffServices: [{ serviceId: service.id }],
};
const secondStaff = {
  id: "staff-2",
  isBookable: true,
  staffServices: [{ serviceId: service.id }],
};

function at(dayKey: string, minutesFromMidnight: number) {
  return zonedMinutesToUtc(parseSalonDay(dayKey), minutesFromMidnight);
}

function withHostTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  return run();
}

function freezeNow(instant: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

function mockBase(
  dayKey: string,
  options?: {
    staff?: { id: string; isBookable: boolean; staffServices: { serviceId: string }[] }[];
  },
) {
  const dayOfWeek = salonDayOfWeek(parseSalonDay(dayKey));
  const members = options?.staff ?? [staff];
  vi.mocked(salonRepository.findServiceBySlug).mockResolvedValue(service as never);
  vi.mocked(salonRepository.listStaff).mockResolvedValue(members as never);
  vi.mocked(salonRepository.listBusinessHours).mockResolvedValue([
    { dayOfWeek, startMin: OPEN_MIN, endMin: CLOSE_MIN, isOpen: true },
  ] as never);
  vi.mocked(salonRepository.listStaffAvailability).mockResolvedValue([
    { dayOfWeek, startMin: OPEN_MIN, endMin: CLOSE_MIN },
  ] as never);
  vi.mocked(salonRepository.listStaffTimeOff).mockResolvedValue([]);
  vi.mocked(salonRepository.listBlockedAppointments).mockResolvedValue([]);
  vi.mocked(salonRepository.findOrCreateCustomerByEmail).mockResolvedValue({
    id: "customer-1",
  } as never);
  vi.mocked(salonRepository.recordConsent).mockResolvedValue({} as never);
  vi.mocked(salonRepository.createAppointmentIfAvailable).mockResolvedValue({
    id: "appointment-1",
  } as never);
  vi.mocked(salonRepository.rescheduleAppointmentIfAvailable).mockResolvedValue({
    id: "appointment-1",
  } as never);
}

function book(startsAt: Date, overrides: Record<string, unknown> = {}) {
  return new BookingService().createBooking({
    serviceSlug: service.slug,
    startsAt: startsAt.toISOString(),
    customerEmail: "customer@example.com",
    staffId: staff.id,
    termsAccepted: true,
    ...overrides,
  });
}

function starts(slots: { startsAt: Date | string }[]): string[] {
  return slots.map((slot) => new Date(slot.startsAt).toISOString());
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("BookingService availability enforcement", () => {
  it("creates a booking only through the atomic repository path", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const startsAt = at("2026-08-04", 10 * 60);

    const result = await book(startsAt);

    expect(result).toEqual({ id: "appointment-1" });
    expect(salonRepository.createAppointmentIfAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: staff.id, startsAt }),
    );
  });

  it("rejects a booking during staff time off", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const startsAt = at("2026-08-04", 10 * 60);
    vi.mocked(salonRepository.listStaffTimeOff).mockResolvedValue([
      {
        startsAt: new Date(startsAt.getTime() - 30 * 60_000),
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      },
    ] as never);

    await expect(book(startsAt)).rejects.toThrow("SLOT_NOT_AVAILABLE");
    expect(salonRepository.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("rejects a booking outside business hours", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    await expect(book(at("2026-08-04", 7 * 60))).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });

  it("rejects an overlapping appointment including its buffer", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const startsAt = at("2026-08-04", 10 * 60);
    vi.mocked(salonRepository.listBlockedAppointments).mockResolvedValue([
      {
        id: "existing",
        staffId: staff.id,
        startsAt: new Date(startsAt.getTime() - 45 * 60_000),
        endsAt: new Date(startsAt.getTime() - 5 * 60_000),
        service: { bufferAfterMin: 15 },
      },
    ] as never);

    await expect(book(startsAt)).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });

  it("ignores an appointment that belongs to a different staff member", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const startsAt = at("2026-08-04", 10 * 60);
    vi.mocked(salonRepository.listBlockedAppointments).mockResolvedValue([
      {
        id: "someone-else",
        staffId: "staff-99",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        service: { bufferAfterMin: 15 },
      },
    ] as never);

    await expect(book(startsAt)).resolves.toEqual({ id: "appointment-1" });
  });
});

describe("BookingService timezone regression", () => {
  it("business hours 08:00-17:00 open at 06:00Z in August on every host timezone", async () => {
    for (const hostZone of HOST_ZONES) {
      vi.clearAllMocks();
      freezeNow("2026-08-03T08:00:00.000Z");
      mockBase("2026-08-04");
      const slots = await withHostTimeZone(hostZone, () =>
        new BookingService().getAvailability(service.slug, "2026-08-04"),
      );
      expect(starts(slots)[0]).toBe("2026-08-04T06:00:00.000Z");
      expect(starts(slots).at(-1)).toBe("2026-08-04T13:45:00.000Z");
      expect(slots).toHaveLength(32);
      vi.useRealTimers();
    }
  });

  it("business hours 08:00-17:00 open at 07:00Z in January on every host timezone", async () => {
    for (const hostZone of HOST_ZONES) {
      vi.clearAllMocks();
      freezeNow("2026-01-12T08:00:00.000Z");
      mockBase("2026-01-13");
      const slots = await withHostTimeZone(hostZone, () =>
        new BookingService().getAvailability(service.slug, "2026-01-13"),
      );
      expect(starts(slots)[0]).toBe("2026-01-13T07:00:00.000Z");
      expect(slots).toHaveLength(32);
      vi.useRealTimers();
    }
  });

  it("produces byte identical availability on every host timezone", async () => {
    const results: string[] = [];
    for (const hostZone of HOST_ZONES) {
      vi.clearAllMocks();
      freezeNow("2026-08-03T08:00:00.000Z");
      mockBase("2026-08-04");
      const slots = await withHostTimeZone(hostZone, () =>
        new BookingService().getAvailability(service.slug, "2026-08-04"),
      );
      results.push(starts(slots).join("|"));
      vi.useRealTimers();
    }
    expect(new Set(results).size).toBe(1);
  });

  it("queries the appointment book over the salon day, not the host day", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(salonRepository.listBlockedAppointments).toHaveBeenCalledWith(
      undefined,
      new Date("2026-08-03T22:00:00.000Z"),
      new Date("2026-08-04T22:00:00.000Z"),
    );
  });
});

describe("BookingService DST salon days", () => {
  it("spring forward 2026-03-29 keeps the first slot at 08:00 local", async () => {
    freezeNow("2026-03-28T08:00:00.000Z");
    mockBase("2026-03-29");

    const slots = await new BookingService().getAvailability(service.slug, "2026-03-29");

    expect(starts(slots)[0]).toBe("2026-03-29T06:00:00.000Z");
    expect(slots).toHaveLength(32);
    expect(salonRepository.listBlockedAppointments).toHaveBeenCalledWith(
      undefined,
      new Date("2026-03-28T23:00:00.000Z"),
      new Date("2026-03-29T22:00:00.000Z"),
    );
  });

  it("fall back 2026-10-25 keeps the first slot at 08:00 local", async () => {
    freezeNow("2026-10-24T08:00:00.000Z");
    mockBase("2026-10-25");

    const slots = await new BookingService().getAvailability(service.slug, "2026-10-25");

    expect(starts(slots)[0]).toBe("2026-10-25T07:00:00.000Z");
    expect(slots).toHaveLength(32);
    expect(salonRepository.listBlockedAppointments).toHaveBeenCalledWith(
      undefined,
      new Date("2026-10-24T22:00:00.000Z"),
      new Date("2026-10-25T23:00:00.000Z"),
    );
  });

  it("books an appointment on the spring forward day at the right instant", async () => {
    freezeNow("2026-03-28T08:00:00.000Z");
    mockBase("2026-03-29");
    const startsAt = at("2026-03-29", 10 * 60);

    await expect(book(startsAt)).resolves.toEqual({ id: "appointment-1" });
    expect(startsAt.toISOString()).toBe("2026-03-29T08:00:00.000Z");
  });
});

describe("BookingService day input handling", () => {
  it("accepts a plain salon day key", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    const slots = await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(starts(slots)[0]).toBe("2026-08-04T06:00:00.000Z");
  });

  it("accepts the legacy UTC anchored instant the wizard sends", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    const legacy = await new BookingService().getAvailability(
      service.slug,
      new Date("2026-08-04T09:00:00.000Z").toISOString(),
    );

    vi.clearAllMocks();
    mockBase("2026-08-04");
    const dayKey = await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(starts(legacy)).toEqual(starts(dayKey));
  });

  it("rejects garbage instead of producing an Invalid Date", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    for (const day of ["", "tomorrow", "04.08.2026", "2026-08-04T09:00:00", "2026-02-30"]) {
      await expect(new BookingService().getAvailability(service.slug, day)).rejects.toThrow(
        "INVALID_DAY",
      );
    }
    expect(salonRepository.listBusinessHours).not.toHaveBeenCalled();
  });
});

describe("BookingService business hours boundaries", () => {
  it("allows a booking exactly at opening time", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    await expect(book(at("2026-08-04", OPEN_MIN))).resolves.toEqual({ id: "appointment-1" });
  });

  it("allows the last booking whose buffer still ends at closing time", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    await expect(book(at("2026-08-04", CLOSE_MIN - 75))).resolves.toEqual({
      id: "appointment-1",
    });
  });

  it("rejects a booking that would end after closing time because of the buffer", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");

    await expect(book(at("2026-08-04", CLOSE_MIN - 60))).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });

  it("returns nothing on a closed day", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    vi.mocked(salonRepository.listBusinessHours).mockResolvedValue([
      {
        dayOfWeek: salonDayOfWeek(parseSalonDay("2026-08-04")),
        startMin: OPEN_MIN,
        endMin: CLOSE_MIN,
        isOpen: false,
      },
    ] as never);

    await expect(new BookingService().getAvailability(service.slug, "2026-08-04")).resolves.toEqual(
      [],
    );
  });
});

describe("BookingService lead time and horizon", () => {
  it("rejects a booking inside the minimum lead time", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-03");
    const tooSoon = new Date(Date.now() + (MIN_BOOKING_LEAD_MINUTES - 15) * 60_000);

    await expect(book(tooSoon)).rejects.toThrow("BOOKING_TOO_SOON");
    expect(salonRepository.listStaff).not.toHaveBeenCalled();
  });

  it("accepts a booking exactly at the minimum lead time", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-03");
    const earliest = new Date(Date.now() + MIN_BOOKING_LEAD_MINUTES * 60_000);

    expect(earliest.toISOString()).toBe("2026-08-03T10:00:00.000Z");
    await expect(book(earliest)).resolves.toEqual({ id: "appointment-1" });
  });

  it("rejects a booking beyond the maximum horizon", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2027-01-31");
    const tooFar = new Date(Date.now() + (MAX_BOOKING_HORIZON_DAYS + 1) * MS_PER_DAY);

    await expect(book(tooFar)).rejects.toThrow("BOOKING_TOO_FAR_AHEAD");
    expect(salonRepository.listStaff).not.toHaveBeenCalled();
  });

  it("accepts a booking on the last day inside the horizon", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2027-01-30");
    const lastDay = at("2027-01-30", 10 * 60);

    expect(lastDay.getTime()).toBeGreaterThan(
      Date.now() + (MAX_BOOKING_HORIZON_DAYS - 1) * MS_PER_DAY,
    );
    await expect(book(lastDay)).resolves.toEqual({ id: "appointment-1" });
  });

  it("never offers a slot the booking rules would reject", async () => {
    freezeNow("2026-08-04T09:00:00.000Z");
    mockBase("2026-08-04");

    const slots = await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(starts(slots)[0]).toBe("2026-08-04T11:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-04T06:00:00.000Z");
  });
});

describe("BookingService staff rules", () => {
  it("narrows availability to the staff rule inside the business hours", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    vi.mocked(salonRepository.listStaffAvailability).mockResolvedValue([
      {
        dayOfWeek: salonDayOfWeek(parseSalonDay("2026-08-04")),
        startMin: 10 * 60,
        endMin: 14 * 60,
      },
    ] as never);

    const slots = await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(starts(slots)[0]).toBe("2026-08-04T08:00:00.000Z");
    expect(starts(slots).at(-1)).toBe("2026-08-04T10:45:00.000Z");
    await expect(book(at("2026-08-04", 9 * 60))).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });

  it("merges two split shifts and leaves the break out", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const dayOfWeek = salonDayOfWeek(parseSalonDay("2026-08-04"));
    vi.mocked(salonRepository.listStaffAvailability).mockResolvedValue([
      { dayOfWeek, startMin: 8 * 60, endMin: 12 * 60 },
      { dayOfWeek, startMin: 14 * 60, endMin: 17 * 60 },
    ] as never);

    const slots = await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(starts(slots)).toContain("2026-08-04T06:00:00.000Z");
    expect(starts(slots)).toContain("2026-08-04T12:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-04T09:00:00.000Z");
  });

  it("returns nothing when the staff member does not work that day", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    vi.mocked(salonRepository.listStaffAvailability).mockResolvedValue([
      {
        dayOfWeek: salonDayOfWeek(parseSalonDay("2026-08-04")) + 1,
        startMin: OPEN_MIN,
        endMin: CLOSE_MIN,
      },
    ] as never);

    await expect(new BookingService().getAvailability(service.slug, "2026-08-04")).resolves.toEqual(
      [],
    );
  });

  it("cuts only the part of the day that a partial time off covers", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    vi.mocked(salonRepository.listStaffTimeOff).mockResolvedValue([
      { startsAt: at("2026-08-04", 12 * 60), endsAt: at("2026-08-04", 13 * 60) },
    ] as never);

    const slots = await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(starts(slots)).toContain("2026-08-04T06:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-04T09:45:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-04T10:45:00.000Z");
    expect(starts(slots)).toContain("2026-08-04T11:15:00.000Z");
  });

  it("loads the shared day data once for the whole eligible team", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04", { staff: [staff, secondStaff] });

    await new BookingService().getAvailability(service.slug, "2026-08-04");

    expect(salonRepository.listBusinessHours).toHaveBeenCalledTimes(1);
    expect(salonRepository.listBlockedAppointments).toHaveBeenCalledTimes(1);
    expect(salonRepository.listStaffAvailability).toHaveBeenCalledTimes(2);
    expect(salonRepository.listStaffTimeOff).toHaveBeenCalledTimes(2);
  });

  it("checks a whole team for one instant without a query per member", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04", { staff: [staff, secondStaff] });

    await book(at("2026-08-04", 10 * 60), { staffId: undefined });

    expect(salonRepository.listBusinessHours).toHaveBeenCalledTimes(1);
    expect(salonRepository.listBlockedAppointments).toHaveBeenCalledTimes(1);
    expect(salonRepository.listStaffAvailability).toHaveBeenCalledTimes(2);
  });
});

describe("BookingService reschedule", () => {
  const appointment = {
    id: "appointment-1",
    serviceId: service.id,
    staffId: staff.id,
    service,
  };

  it("allows rescheduling onto the appointment's own current slot", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const startsAt = at("2026-08-04", 10 * 60);
    vi.mocked(salonRepository.findAppointmentById).mockResolvedValue({
      ...appointment,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    } as never);
    vi.mocked(salonRepository.listBlockedAppointments).mockResolvedValue([
      {
        id: appointment.id,
        staffId: staff.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        service: { bufferAfterMin: 15 },
      },
    ] as never);

    await expect(
      new BookingService().reschedule(appointment.id, startsAt.toISOString()),
    ).resolves.toEqual({ id: "appointment-1" });
    expect(salonRepository.rescheduleAppointmentIfAvailable).toHaveBeenCalledWith(
      appointment.id,
      staff.id,
      startsAt,
      new Date(startsAt.getTime() + 60 * 60_000),
      new Date(startsAt.getTime() + 75 * 60_000),
    );
  });

  it("still refuses a slot another appointment holds", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-04");
    const startsAt = at("2026-08-04", 10 * 60);
    vi.mocked(salonRepository.findAppointmentById).mockResolvedValue({
      ...appointment,
      startsAt: at("2026-08-04", 15 * 60),
      endsAt: at("2026-08-04", 16 * 60),
    } as never);
    vi.mocked(salonRepository.listBlockedAppointments).mockResolvedValue([
      {
        id: "other",
        staffId: staff.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        service: { bufferAfterMin: 15 },
      },
    ] as never);

    await expect(
      new BookingService().reschedule(appointment.id, startsAt.toISOString()),
    ).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });

  it("applies the same lead time as a fresh booking", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2026-08-03");
    vi.mocked(salonRepository.findAppointmentById).mockResolvedValue({
      ...appointment,
      startsAt: at("2026-08-04", 10 * 60),
      endsAt: at("2026-08-04", 11 * 60),
    } as never);
    const tooSoon = new Date(Date.now() + 30 * 60_000);

    await expect(
      new BookingService().reschedule(appointment.id, tooSoon.toISOString()),
    ).rejects.toThrow("BOOKING_TOO_SOON");
    expect(salonRepository.rescheduleAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("applies the same horizon as a fresh booking", async () => {
    freezeNow("2026-08-03T08:00:00.000Z");
    mockBase("2027-01-31");
    vi.mocked(salonRepository.findAppointmentById).mockResolvedValue({
      ...appointment,
      startsAt: at("2026-08-04", 10 * 60),
      endsAt: at("2026-08-04", 11 * 60),
    } as never);
    const tooFar = new Date(Date.now() + (MAX_BOOKING_HORIZON_DAYS + 1) * MS_PER_DAY);

    await expect(
      new BookingService().reschedule(appointment.id, tooFar.toISOString()),
    ).rejects.toThrow("BOOKING_TOO_FAR_AHEAD");
  });
});
