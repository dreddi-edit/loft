import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { BookingService } from "./booking-service";
import { salonRepository } from "./repositories";

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

function nextWeekdayAt(dayOfWeek: number, hour: number) {
  const date = new Date();
  date.setDate(date.getDate() + ((dayOfWeek - date.getDay() + 7) % 7 || 7));
  date.setHours(hour, 0, 0, 0);
  return date;
}

function mockBase(startsAt: Date) {
  vi.mocked(salonRepository.findServiceBySlug).mockResolvedValue(service as never);
  vi.mocked(salonRepository.listStaff).mockResolvedValue([staff] as never);
  vi.mocked(salonRepository.listBusinessHours).mockResolvedValue([
    { dayOfWeek: startsAt.getDay(), startMin: 9 * 60, endMin: 18 * 60, isOpen: true },
  ] as never);
  vi.mocked(salonRepository.listStaffAvailability).mockResolvedValue([
    { dayOfWeek: startsAt.getDay(), startMin: 9 * 60, endMin: 18 * 60 },
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
}

describe("BookingService availability enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a booking only through the atomic repository path", async () => {
    const startsAt = nextWeekdayAt(1, 10);
    mockBase(startsAt);

    const result = await new BookingService().createBooking({
      serviceSlug: service.slug,
      startsAt: startsAt.toISOString(),
      customerEmail: "customer@example.com",
      staffId: staff.id,
      termsAccepted: true,
    });

    expect(result).toEqual({ id: "appointment-1" });
    expect(salonRepository.createAppointmentIfAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: staff.id, startsAt }),
    );
  });

  it("rejects a booking during staff time off", async () => {
    const startsAt = nextWeekdayAt(2, 10);
    mockBase(startsAt);
    vi.mocked(salonRepository.listStaffTimeOff).mockResolvedValue([
      {
        startsAt: new Date(startsAt.getTime() - 30 * 60_000),
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      },
    ] as never);

    await expect(
      new BookingService().createBooking({
        serviceSlug: service.slug,
        startsAt: startsAt.toISOString(),
        customerEmail: "customer@example.com",
        staffId: staff.id,
        termsAccepted: true,
      }),
    ).rejects.toThrow("SLOT_NOT_AVAILABLE");
    expect(salonRepository.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("rejects a booking outside business hours", async () => {
    const startsAt = nextWeekdayAt(3, 8);
    mockBase(startsAt);

    await expect(
      new BookingService().createBooking({
        serviceSlug: service.slug,
        startsAt: startsAt.toISOString(),
        customerEmail: "customer@example.com",
        staffId: staff.id,
        termsAccepted: true,
      }),
    ).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });

  it("rejects an overlapping appointment including its buffer", async () => {
    const startsAt = nextWeekdayAt(4, 10);
    mockBase(startsAt);
    vi.mocked(salonRepository.listBlockedAppointments).mockResolvedValue([
      {
        id: "existing",
        startsAt: new Date(startsAt.getTime() - 45 * 60_000),
        endsAt: new Date(startsAt.getTime() - 5 * 60_000),
        service: { bufferAfterMin: 15 },
      },
    ] as never);

    await expect(
      new BookingService().createBooking({
        serviceSlug: service.slug,
        startsAt: startsAt.toISOString(),
        customerEmail: "customer@example.com",
        staffId: staff.id,
        termsAccepted: true,
      }),
    ).rejects.toThrow("SLOT_NOT_AVAILABLE");
  });
});
