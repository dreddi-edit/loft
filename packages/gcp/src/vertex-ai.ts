import { getGcpAccessToken } from "./access-token";
import { getGcpConfig, isGcpConfigured } from "./config";

export type GeminiToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type GeminiResult = {
  text: string;
  locale: "de" | "it" | "fr" | "en";
  intent: string;
  toolCalls: GeminiToolCall[];
};

const legacyFunctionDeclarations = [
  {
    name: "checkAvailability",
    description: "Check available appointment slots for a service",
    parameters: {
      type: "OBJECT",
      properties: {
        serviceId: { type: "STRING", description: "Service slug or ID" },
      },
      required: ["serviceId"],
    },
  },
  {
    name: "createBooking",
    description: "Create a new salon appointment booking",
    parameters: {
      type: "OBJECT",
      properties: {
        serviceId: { type: "STRING" },
        customerId: { type: "STRING" },
      },
      required: ["serviceId"],
    },
  },
  {
    name: "rescheduleBooking",
    description: "Reschedule an existing appointment",
    parameters: {
      type: "OBJECT",
      properties: {
        appointmentId: { type: "STRING" },
      },
      required: ["appointmentId"],
    },
  },
  {
    name: "cancelBooking",
    description: "Cancel an existing appointment",
    parameters: {
      type: "OBJECT",
      properties: {
        appointmentId: { type: "STRING" },
      },
      required: ["appointmentId"],
    },
  },
  {
    name: "getServiceInfo",
    description: "Get pricing and details for a salon service",
    parameters: {
      type: "OBJECT",
      properties: {
        serviceId: { type: "STRING" },
      },
      required: ["serviceId"],
    },
  },
];

function detectLocaleFromText(text: string): "de" | "it" | "fr" | "en" {
  if (/ciao|buongiorno|prenot/i.test(text)) return "it";
  if (/bonjour|salut|réserver/i.test(text)) return "fr";
  if (/hallo|guten tag|buchen/i.test(text)) return "de";
  return "en";
}

type GeminiPart = {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
};

type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

async function callGemini(input: {
  model: string;
  projectId: string;
  location: string;
  systemPrompt?: string;
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  tools?: boolean;
  functionDeclarations?: GeminiFunctionDeclaration[];
}) {
  const token = await getGcpAccessToken();
  const url = `https://${input.location}-aiplatform.googleapis.com/v1/projects/${input.projectId}/locations/${input.location}/publishers/google/models/${input.model}:generateContent`;

  const body: Record<string, unknown> = {
    contents: input.contents,
  };

  if (input.systemPrompt) {
    body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
  }

  if (input.tools) {
    const declarations = input.functionDeclarations ?? legacyFunctionDeclarations;
    body.tools = [{ functionDeclarations: declarations }];
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`VERTEX_REQUEST_FAILED:${response.status}:${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as GeminiResponse;
}

function parseGeminiResponse(response: GeminiResponse, locale: "de" | "it" | "fr" | "en"): GeminiResult {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: GeminiToolCall[] = [];
  let text = "";

  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        name: part.functionCall.name ?? "unknown",
        args: part.functionCall.args ?? {},
      });
    }
    if (part.text) text += part.text;
  }

  return {
    text: text.trim(),
    locale,
    intent: toolCalls[0]?.name ?? "general_faq",
    toolCalls,
  };
}

export async function runGeminiAssistant(input: {
  text: string;
  locale?: "de" | "it" | "fr" | "en";
  systemPrompt: string;
  conversationHistory?: Array<{ role: "user" | "model"; text: string }>;
  functionDeclarations?: GeminiFunctionDeclaration[];
}): Promise<GeminiResult> {
  const locale = input.locale ?? detectLocaleFromText(input.text);

  if (!isGcpConfigured()) {
    return {
      text: "GCP Vertex AI is not configured. Set GCP_PROJECT_ID to enable Gemini.",
      locale,
      intent: "unconfigured",
      toolCalls: [],
    };
  }

  const config = getGcpConfig();
  const history = (input.conversationHistory ?? []).map((entry) => ({
    role: entry.role === "model" ? "model" : "user",
    parts: [{ text: entry.text }],
  }));

  const response = await callGemini({
    model: config.geminiModel,
    projectId: config.projectId,
    location: config.vertexLocation,
    systemPrompt: input.systemPrompt,
    contents: [...history, { role: "user", parts: [{ text: input.text }] }],
    tools: true,
    functionDeclarations: input.functionDeclarations,
  });

  return parseGeminiResponse(response, locale);
}

export async function synthesizeGeminiResponse(input: {
  text: string;
  locale?: "de" | "it" | "fr" | "en";
  systemPrompt: string;
  toolResults: Array<{ name: string; result: string }>;
}): Promise<string> {
  if (!isGcpConfigured()) {
    return input.toolResults.map((entry) => entry.result).join(" ") || input.text;
  }

  const config = getGcpConfig();
  const toolSummary = input.toolResults.map((entry) => `${entry.name}: ${entry.result}`).join("\n");
  const prompt = [
    input.systemPrompt,
    `User message: ${input.text}`,
    toolSummary ? `Tool results:\n${toolSummary}` : "",
    "Respond naturally in the user's language. Be concise and helpful.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await callGemini({
    model: config.geminiModel,
    projectId: config.projectId,
    location: config.vertexLocation,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return parseGeminiResponse(response, input.locale ?? "en").text || toolSummary;
}
