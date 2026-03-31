import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { AlertCircle } from "lucide-react";

const Events = () => {
  const { lang } = useLanguage();
  const t = translations[lang].events;
  const sectionRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("visible", e.isIntersecting)),
      { threshold: 0.1 }
    );
    sectionRef.current?.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [lang]);

  const marqueeItems = [...t.items, ...t.items];

  return (
    <section id="events" className="py-24 sm:py-32 bg-white overflow-hidden" ref={sectionRef} data-testid="events-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 mb-16">
        <p className="overline-text reveal">{t.overline}</p>
        <div className="section-divider reveal" />
        <h2
          className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight reveal"
          style={{ fontFamily: "'Cormorant Garamond', serif" }}
          data-testid="events-title"
        >
          {t.title}
        </h2>
      </div>

      {/* Marquee */}
      <div className="border-y border-zinc-200 py-5 overflow-hidden mb-16" data-testid="events-marquee">
        <div className="marquee-track">
          {marqueeItems.map((item, i) => (
            <span key={i} className="flex items-center gap-4 px-6 text-sm font-medium text-zinc-700 whitespace-nowrap">
              {item}
              <span className="w-1 h-1 rounded-full bg-zinc-300 flex-shrink-0" />
            </span>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {t.items.map((item, i) => (
            <div
              key={i}
              className="reveal sharp-card bg-zinc-50 px-5 py-4 text-sm font-medium text-zinc-700 hover:bg-zinc-900 hover:text-white transition-colors cursor-default"
              style={{ transitionDelay: `${i * 0.05}s` }}
              data-testid={`event-type-${i}`}
            >
              {item}
            </div>
          ))}
        </div>

        {/* Note */}
        <div className="mt-10 flex items-start gap-3 reveal" data-testid="events-note">
          <AlertCircle size={16} className="text-zinc-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-zinc-500 italic">{t.note}</p>
        </div>
      </div>
    </section>
  );
};

export default Events;
