import { describe, expect, it } from "vitest";
import { detectIntent, detectLocaleFromInput } from "./index";

describe("detectLocaleFromInput", () => {
  it("detects italian", () => {
    expect(detectLocaleFromInput("Ciao, vorrei prenotare")).toBe("it");
  });
  it("detects french", () => {
    expect(detectLocaleFromInput("Bonjour, je voudrais réserver")).toBe("fr");
  });
  it("detects german", () => {
    expect(detectLocaleFromInput("Hallo, ich möchte buchen")).toBe("de");
  });
});

describe("detectIntent", () => {
  it("detects booking create", () => {
    expect(detectIntent("I want to book tomorrow")).toBe("booking_create");
  });
  it("detects cancellation", () => {
    expect(detectIntent("Please cancel my appointment")).toBe("booking_cancel");
  });
  it("detects price lookup", () => {
    expect(detectIntent("What is the price for haircut?")).toBe("price_lookup");
  });
});
