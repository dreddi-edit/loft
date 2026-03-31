import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { Wifi, Monitor, UtensilsCrossed, Building2, Check } from "lucide-react";

const categoryIcons = [Wifi, Monitor, UtensilsCrossed, Building2];

const Amenities = () => {
  const { lang } = useLanguage();
  const t = translations[lang].amenities;
  const sectionRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("visible", e.isIntersecting)),
      { threshold: 0.1 }
    );
    sectionRef.current?.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [lang]);

  return (
    <section id="amenities" className="py-24 sm:py-32 bg-zinc-900 text-white" ref={sectionRef} data-testid="amenities-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="mb-16">
          <p className="overline-text text-zinc-400 reveal">{t.overline}</p>
          <div className="w-10 h-px bg-white my-4 reveal" />
          <h2
            className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight reveal"
            style={{ fontFamily: "'Cormorant Garamond', serif" }}
            data-testid="amenities-title"
          >
            {t.title}
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {t.categories.map((cat, i) => {
            const Icon = categoryIcons[i];
            return (
              <div
                key={i}
                className="reveal"
                style={{ transitionDelay: `${i * 0.1}s` }}
                data-testid={`amenity-category-${i}`}
              >
                <div className="flex items-center gap-3 mb-5">
                  <Icon size={18} className="text-zinc-400" />
                  <h3 className="text-sm font-semibold tracking-wide text-white">{cat.title}</h3>
                </div>
                <ul className="space-y-3">
                  {cat.items.map((item, j) => (
                    <li key={j} className="flex items-center gap-2.5 text-sm text-zinc-400">
                      <Check size={13} className="text-zinc-500 flex-shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default Amenities;
