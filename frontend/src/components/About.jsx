import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";

const About = () => {
  const { lang } = useLanguage();
  const t = translations[lang].about;
  const sectionRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("visible", e.isIntersecting)),
      { threshold: 0.15 }
    );
    const els = sectionRef.current?.querySelectorAll(".reveal");
    els?.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [lang]);

  return (
    <section id="about" className="py-24 sm:py-32 bg-white" ref={sectionRef} data-testid="about-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-center">
          {/* Left: Text */}
          <div>
            <p className="overline-text reveal">{t.overline}</p>
            <div className="section-divider reveal" />
            <h2
              className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight mb-8 reveal"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
              data-testid="about-title"
            >
              {t.title}
            </h2>
            <p className="text-base sm:text-lg text-zinc-600 leading-relaxed reveal" data-testid="about-text">
              {t.text}
            </p>
          </div>

          {/* Right: Stats */}
          <div className="grid grid-cols-2 gap-6">
            {t.stats.map((stat, i) => (
              <div
                key={i}
                className="reveal sharp-card p-8 bg-zinc-50"
                style={{ transitionDelay: `${i * 0.1}s` }}
                data-testid={`about-stat-${i}`}
              >
                <p
                  className="text-3xl sm:text-4xl font-light mb-2 text-zinc-900"
                  style={{ fontFamily: "'Cormorant Garamond', serif" }}
                >
                  {stat.value}
                </p>
                <p className="text-sm text-zinc-500 font-medium">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default About;
