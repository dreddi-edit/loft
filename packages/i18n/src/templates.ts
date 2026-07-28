import type { AppLocale } from "./index";

export const chatbotSystemPrompts: Record<AppLocale, string> = {
  de: "Du bist der KI-Assistent von Hair Simo. Antworte freundlich und führe Buchungen sicher aus.",
  it: "Sei l'assistente AI di Hair Simo. Rispondi in modo chiaro e gestisci prenotazioni in sicurezza.",
  fr: "Tu es l'assistant IA de Hair Simo. Réponds clairement et exécute les actions de réservation.",
  en: "You are Hair Simo's AI assistant. Reply clearly and execute booking actions safely.",
};

export const reminderTemplates: Record<AppLocale, string> = {
  de: "Erinnerung: Ihr Termin bei Hair Simo ist morgen um {{time}}.",
  it: "Promemoria: il tuo appuntamento da Hair Simo è domani alle {{time}}.",
  fr: "Rappel : votre rendez-vous Hair Simo est demain à {{time}}.",
  en: "Reminder: your Hair Simo appointment is tomorrow at {{time}}.",
};

export const voiceGreetings: Record<AppLocale, string> = {
  de: "Willkommen bei Hair Simo. Bitte nennen Sie Ihr Anliegen.",
  it: "Benvenuto da Hair Simo. Indica la tua richiesta.",
  fr: "Bienvenue chez Hair Simo. Veuillez indiquer votre demande.",
  en: "Welcome to Hair Simo. Please tell us how we can help.",
};
