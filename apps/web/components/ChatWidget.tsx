"use client";

import { useEffect, useRef, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Button } from "@hair-simo/ui";

type PublicConfig = {
  gcpEnabled: boolean;
  paymentsMockEnabled: boolean;
  googlePayConfigured: boolean;
  environment: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  meta?: string;
};

type ChatWidgetProps = {
  locale: AppLocale;
};

export function ChatWidget({ locale }: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "voice">("chat");
  const [input, setInput] = useState("");
  const [voiceInput, setVoiceInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/config/public")
      .then((res) => res.json())
      .then((json) => setConfig(json.data ?? null))
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          text: t(locale, "chat_welcome"),
        },
      ]);
    }
  }, [open, locale, messages.length]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function sendChat(text: string) {
    if (!text.trim()) return;
    const userMessage: Message = { id: `u-${Date.now()}`, role: "user", text: text.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);
    try {
      const history = [...messages, userMessage]
        .filter((entry) => entry.id !== "welcome")
        .map((entry) => ({
          role: entry.role === "user" ? ("user" as const) : ("model" as const),
          text: entry.text,
        }));

      const response = await fetch("/api/chat/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), locale, conversationHistory: history }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "CHAT_FAILED");

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: json.data.response,
          meta: json.data.provider,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: "assistant",
          text: error instanceof Error ? error.message : t(locale, "error_generic"),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function simulateVoice() {
    if (!voiceInput.trim()) return;
    const userMessage: Message = { id: `v-${Date.now()}`, role: "user", text: voiceInput.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setVoiceInput("");
    setLoading(true);
    try {
      const response = await fetch("/api/voice/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: userMessage.text, locale }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "VOICE_FAILED");

      setMessages((prev) => [
        ...prev,
        {
          id: `va-${Date.now()}`,
          role: "assistant",
          text: json.data.response,
          meta: json.data.audioBase64 ? "voice+audio" : json.data.provider ?? "voice-simulator",
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: `ve-${Date.now()}`,
          role: "assistant",
          text: error instanceof Error ? error.message : t(locale, "error_generic"),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {!open ? (
        <button type="button" className="hs-chat-fab" onClick={() => setOpen(true)} aria-label={t(locale, "chat_open")}>
          💬
        </button>
      ) : null}

      {open ? (
        <div className="hs-chat-panel" role="dialog" aria-label={t(locale, "chat_title")}>
          <header className="hs-chat-header">
            <div>
              <strong>{t(locale, "chat_title")}</strong>
              {config ? (
                <p className="hs-chat-meta">
                  {config.gcpEnabled ? "GCP" : "Local"} · {config.environment}
                </p>
              ) : null}
            </div>
            <button type="button" className="hs-chat-close" onClick={() => setOpen(false)} aria-label={t(locale, "chat_close")}>
              ×
            </button>
          </header>

          <div className="hs-chat-tabs">
            <button type="button" className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
              {t(locale, "chat_text_tab")}
            </button>
            <button type="button" className={tab === "voice" ? "active" : ""} onClick={() => setTab("voice")}>
              {t(locale, "chat_voice_tab")}
            </button>
          </div>

          <div className="hs-chat-messages" ref={listRef}>
            {messages.map((message) => (
              <div key={message.id} className={`hs-chat-bubble ${message.role}`}>
                <p>{message.text}</p>
                {message.meta ? <span className="hs-chat-meta">{message.meta}</span> : null}
              </div>
            ))}
            {loading ? <p className="hs-chat-meta">{t(locale, "chat_thinking")}</p> : null}
          </div>

          {tab === "chat" ? (
            <form
              className="hs-chat-input-row"
              onSubmit={(event) => {
                event.preventDefault();
                void sendChat(input);
              }}
            >
              <input
                className="hs-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t(locale, "chat_placeholder")}
              />
              <Button type="submit" disabled={loading}>
                {t(locale, "chat_send")}
              </Button>
            </form>
          ) : (
            <div className="hs-chat-input-row hs-grid">
              <p className="hs-chat-meta">{t(locale, "chat_voice_hint")}</p>
              <textarea
                className="hs-textarea"
                rows={3}
                value={voiceInput}
                onChange={(event) => setVoiceInput(event.target.value)}
                placeholder={t(locale, "chat_voice_placeholder")}
              />
              <Button type="button" disabled={loading} onClick={() => void simulateVoice()}>
                {t(locale, "chat_voice_simulate")}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
