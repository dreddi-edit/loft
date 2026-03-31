import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { Check, Clock, AlertCircle } from "lucide-react";

const Pricing = () => {
  const { lang } = useLanguage();
  const t = translations[lang].pricing;
  const sectionRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("visible", e.isIntersecting)),
      { threshold: 0.15 }
    );
    sectionRef.current?.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [lang]);

  return (
    <section id="pricing" className="py-24 sm:py-32 bg-zinc-50" ref={sectionRef} data-testid="pricing-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
          {/* Left: Header */}
          <div>
            <p className="overline-text reveal">{t.overline}</p>
            <div className="section-divider reveal" />
            <h2
              className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight mb-8 reveal"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
              data-testid="pricing-title"
            >
              {t.title}
            </h2>

            {/* Hours */}
            <div className="flex items-start gap-3 mb-4 reveal">
              <Clock size={16} className="text-zinc-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-zinc-900">{t.hours}</p>
                <p className="text-sm text-zinc-500">{t.hoursNote}</p>
              </div>
            </div>

            {/* Price Note */}
            <div className="flex items-start gap-3 reveal">
              <AlertCircle size={16} className="text-zinc-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-zinc-500">{t.priceNote}</p>
            </div>
          </div>

          {/* Right: Price Card */}
          <div className="reveal sharp-card bg-white p-10">
            {t.packages.map((pkg, i) => (
              <div key={i} data-testid={`pricing-package-${i}`}>
                <p className="overline-text mb-3">{pkg.name}</p>
                <div className="flex items-baseline gap-2 mb-2">
                  <span
                    className="text-5xl font-light text-zinc-900"
                    style={{ fontFamily: "'Cormorant Garamond', serif" }}
                    data-testid="pricing-price"
                  >
                    {pkg.price}
                  </span>
                  <span className="text-base text-zinc-500">{pkg.unit}</span>
                </div>
                <p className="text-sm text-zinc-400 mb-8">
                  {t.grossLabel}: {t.gross}
                </p>

                <ul className="space-y-3 mb-10">
                  {pkg.features.map((f, j) => (
                    <li key={j} className="flex items-center gap-3 text-sm text-zinc-700">
                      <Check size={14} className="text-zinc-400 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                <a
                  href="#booking"
                  className="block w-full text-center bg-zinc-900 text-white text-sm font-medium py-4 hover:bg-zinc-700 transition-colors"
                  data-testid="pricing-cta"
                >
                  {t.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default Pricing;
