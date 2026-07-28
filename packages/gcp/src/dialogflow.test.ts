import { describe, expect, it } from "vitest";
import { parseDialogflowWebhook, buildDialogflowResponse } from "./dialogflow";
import { getTtsVoiceForLocale } from "./config";

describe("dialogflow webhook", () => {
  it("parses dialogflow cx webhook payload", () => {
    const result = parseDialogflowWebhook({
      session: "projects/test/agent/sessions/abc",
      queryResult: {
        queryText: "I want to book an appointment",
        languageCode: "de-DE",
        intent: { displayName: "booking_create" },
        intentDetectionConfidence: 0.92,
        parameters: { serviceId: "haircut-women" },
      },
    });

    expect(result.text).toBe("I want to book an appointment");
    expect(result.locale).toBe("de");
    expect(result.intent).toBe("booking_create");
    expect(result.confidence).toBe(0.92);
  });

  it("builds dialogflow response", () => {
    const response = buildDialogflowResponse("Hello from Hair Simo");
    expect(response.fulfillmentResponse.messages[0].text.text).toEqual(["Hello from Hair Simo"]);
  });
});

describe("tts voice mapping", () => {
  it("returns default chirp3 hd voices", () => {
    expect(getTtsVoiceForLocale("de")).toContain("Chirp3-HD");
    expect(getTtsVoiceForLocale("en")).toContain("Chirp3-HD");
  });
});
