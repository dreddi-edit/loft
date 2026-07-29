import { runGeminiAssistant } from "../packages/gcp/src/vertex-ai";

async function main() {
  try {
    const result = await runGeminiAssistant({
      text: "Hallo, welche Services bietet ihr an?",
      locale: "de",
      systemPrompt: "You are a helpful salon assistant.",
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("GEMINI_ERROR", error);
    process.exit(1);
  }
}

void main();
