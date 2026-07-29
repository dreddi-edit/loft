"use client";

import { useEffect, useRef, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { BrandLogo, Button } from "@hair-simo/ui";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions?: Array<{ label: string; href?: string; prompt?: string }>;
};

type ChatWidgetProps = {
  locale: AppLocale;
};

export function ChatWidget({ locale }: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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
          actions: json.data.actions ?? [],
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

  return (
    <>
      {!open ? (
        <button type="button" className="hs-chat-fab" onClick={() => setOpen(true)} aria-label={t(locale, "chat_open")}>
          <img src="/brand/logo.png" alt="" className="hs-chat-fab-logo" />
        </button>
      ) : null}

      {open ? (
        <div className="hs-chat-panel" role="dialog" aria-label={t(locale, "chat_title")}>
          <header className="hs-chat-header">
            <div className="hs-chat-header-brand">
              <BrandLogo alt={t(locale, "site_title")} size="sm" />
              <strong>{t(locale, "chat_title")}</strong>
            </div>
            <button type="button" className="hs-chat-close" onClick={() => setOpen(false)} aria-label={t(locale, "chat_close")}>
              ×
            </button>
          </header>

          <div className="hs-chat-messages" ref={listRef}>
            {messages.map((message) => (
              <div key={message.id} className={`hs-chat-bubble ${message.role}`}>
                <p>{message.text}</p>
                {message.actions?.length ? (
                  <div className="hs-chat-actions">
                    {message.actions.map((action, index) =>
                      action.href ? (
                        <a key={`${action.label}-${index}`} className="hs-chat-action-link" href={action.href}>
                          {action.label}
                        </a>
                      ) : (
                        <button
                          key={`${action.label}-${index}`}
                          type="button"
                          className="hs-chat-action-button"
                          onClick={() => {
                            if (action.prompt) void sendChat(action.prompt);
                          }}
                        >
                          {action.label}
                        </button>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            ))}
            {loading ? <p className="hs-chat-meta">{t(locale, "chat_thinking")}</p> : null}
          </div>

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
        </div>
      ) : null}
    </>
  );
}
