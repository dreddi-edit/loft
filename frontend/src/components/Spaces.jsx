import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";

const SPACE_IMAGES = [
  "https://images.eventbook.com/_/w:1200/h:800/rt:fill-down/plain/production://public/uploads/rIjoZaMpuvg0nj6VPzAfvEUU6K4dJme7Sjdo9H7z.jpg",
  "https://images.eventbook.com/_/w:1200/h:800/rt:fill-down/plain/production://public/uploads/ipBZnzbafFgF7SVdXVc2mNUAldYgjlFEidiHAlcS.jpg",
  "https://images.eventbook.com/_/w:1200/h:800/rt:fill-down/plain/production://public/uploads/j5Wy4b7jsj4UdIwCUC6wdSlQmi7Q1y2OWbqPQiHe.jpg",
];

const Spaces = () => {
  const { lang } = useLanguage();
  const t = translations[lang].spaces;
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
    <section id="spaces" className="py-24 sm:py-32 bg-zinc-50" ref={sectionRef} data-testid="spaces-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        {/* Header */}
        <div className="mb-16">
          <p className="overline-text reveal">{t.overline}</p>
          <div className="section-divider reveal" />
          <h2
            className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight reveal max-w-lg"
            style={{ fontFamily: "'Cormorant Garamond', serif" }}
            data-testid="spaces-title"
          >
            {t.title}
          </h2>
        </div>

        {/* Spaces Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {t.items.map((space, i) => (
            <div
              key={i}
              className="reveal sharp-card bg-white overflow-hidden group"
              style={{ transitionDelay: `${i * 0.12}s` }}
              data-testid={`space-card-${i}`}
            >
              {/* Image */}
              <div className="img-zoom h-64 bg-zinc-100">
                <img
                  src={SPACE_IMAGES[i]}
                  alt={space.name}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.target.src = "https://images.pexels.com/photos/9300740/pexels-photo-9300740.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940";
                  }}
                />
              </div>

              {/* Content */}
              <div className="p-8">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <span className="inline-block text-xs font-semibold tracking-widest uppercase text-zinc-400 mb-2">
                      {space.tag}
                    </span>
                    <h3
                      className="text-xl sm:text-2xl font-light text-zinc-900"
                      style={{ fontFamily: "'Cormorant Garamond', serif" }}
                    >
                      {space.name}
                    </h3>
                  </div>
                  <span className="text-sm font-medium text-zinc-500 mt-1">{space.size}</span>
                </div>
                <p className="text-sm text-zinc-600 leading-relaxed mb-6">{space.desc}</p>
                <div className="border-t border-zinc-100 pt-4">
                  {i === 0 ? (
                    <p className="text-sm text-zinc-900 font-medium">
                      {t.priceFrom}<span className="font-semibold">195 €</span>{t.priceHour}
                    </p>
                  ) : (
                    <p className="text-sm text-zinc-500">{t.priceRequest}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Spaces;
