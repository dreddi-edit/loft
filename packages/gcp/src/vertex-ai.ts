import { FunctionDeclarationSchemaType, VertexAI, type FunctionDeclaration } from "@google-cloud/vertexai";
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

const functionDeclarations = [
  {
    name: "checkAvailability",
    description: "Check available appointment slots for a service",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        serviceId: { type: FunctionDeclarationSchemaType.STRING, description: "Service slug or ID" },
      },
      required: ["serviceId"],
    },
  },
  {
    name: "createBooking",
    description: "Create a new salon appointment booking",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        serviceId: { type: FunctionDeclarationSchemaType.STRING },
        customerId: { type: FunctionDeclarationSchemaType.STRING },
      },
      required: ["serviceId"],
    },
  },
  {
    name: "rescheduleBooking",
    description: "Reschedule an existing appointment",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        appointmentId: { type: FunctionDeclarationSchemaType.STRING },
      },
      required: ["appointmentId"],
    },
  },
  {
    name: "cancelBooking",
    description: "Cancel an existing appointment",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        appointmentId: { type: FunctionDeclarationSchemaType.STRING },
      },
      required: ["appointmentId"],
    },
  },
  {
    name: "getServiceInfo",
    description: "Get pricing and details for a salon service",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        serviceId: { type: FunctionDeclarationSchemaType.STRING },
      },
      required: ["serviceId"],
    },
  },
] as FunctionDeclaration[];

function detectLocaleFromText(text: string): "de" | "it" | "fr" | "en" {
  if (/ciao|buongiorno|prenot/i.test(text)) return "it";
  if (/bonjour|salut|réserver/i.test(text)) return "fr";
  if (/hallo|guten tag|buchen/i.test(text)) return "de";
  return "en";
}

export async function runGeminiAssistant(input: {
  text: string;
  locale?: "de" | "it" | "fr" | "en";
  systemPrompt: string;
  conversationHistory?: Array<{ role: "user" | "model"; text: string }>;
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
  const vertex = new VertexAI({ project: config.projectId, location: config.vertexLocation });
  const model = vertex.getGenerativeModel({
    model: config.geminiModel,
    tools: [{ functionDeclarations }],
    systemInstruction: {
      role: "system",
      parts: [{ text: input.systemPrompt }],
    },
  });

  const history = (input.conversationHistory ?? []).map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));

  const chat = model.startChat({ history });
  const response = await chat.sendMessage(input.text);
  const candidate = response.response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const toolCalls: GeminiToolCall[] = [];
  let text = "";

  for (const part of parts) {
    if ("functionCall" in part && part.functionCall) {
      toolCalls.push({
        name: part.functionCall.name ?? "unknown",
        args: (part.functionCall.args as Record<string, unknown>) ?? {},
      });
    }
    if ("text" in part && part.text) {
      text += part.text;
    }
  }

  const intent = toolCalls[0]?.name ?? "general_faq";

  return { text: text.trim(), locale, intent, toolCalls };
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
  const vertex = new VertexAI({ project: config.projectId, location: config.vertexLocation });
  const model = vertex.getGenerativeModel({ model: config.geminiModel });

  const toolSummary = input.toolResults.map((entry) => `${entry.name}: ${entry.result}`).join("\n");
  const prompt = [
    input.systemPrompt,
    `User message: ${input.text}`,
    toolSummary ? `Tool results:\n${toolSummary}` : "",
    "Respond naturally in the user's language. Be concise and helpful.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await model.generateContent(prompt);
  return response.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? toolSummary;
}
