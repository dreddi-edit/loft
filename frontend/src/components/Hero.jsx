import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { ArrowDown } from "lucide-react";

const HERO_IMAGE =
  "https://images.eventbook.com/_/w:1600/h:1000/rt:fill-down/plain/production://public/uploads/rIjoZaMpuvg0nj6VPzAfvEUU6K4dJme7Sjdo9H7z.jpg";

const Hero = () => {
  const { lang } = useLanguage();
  const t = translations[lang].hero;

  return (
    <section className="relative h-screen min-h-[600px] flex items-center overflow-hidden" data-testid="hero-section">
      {/* Background Image */}
      <div className="absolute inset-0 img-zoom">
        <img
          src={HERO_IMAGE}
          alt="THE LOFT Düsseldorf"
          className="w-full h-full object-cover"
        />
      </div>

      {/* Overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/40 to-black/20" />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6 sm:px-8 w-full">
        <div className="max-w-2xl">
          <p className="overline-text text-white/70 mb-6 fade-in-up" data-testid="hero-overline">
            {t.overline}
          </p>
          <h1
            className="font-heading text-5xl sm:text-6xl lg:text-7xl font-light text-white leading-tight mb-6 fade-in-up fade-in-up-delay-1"
            style={{ fontFamily: "'Cormorant Garamond', serif" }}
            data-testid="hero-title"
          >
            {t.title.split("\n").map((line, i) => (
              <span key={i}>
                {line}
                {i < t.title.split("\n").length - 1 && <br />}
              </span>
            ))}
          </h1>
          <p
            className="text-base sm:text-lg text-white/80 mb-10 leading-relaxed fade-in-up fade-in-up-delay-2"
            data-testid="hero-subtitle"
          >
            {t.subtitle}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 fade-in-up fade-in-up-delay-3">
            <a
              href="#booking"
              className="inline-flex items-center justify-center bg-white text-zinc-900 text-sm font-semibold px-8 py-4 hover:bg-zinc-100 transition-colors"
              data-testid="hero-cta-primary"
            >
              {t.cta}
            </a>
            <a
              href="#spaces"
              className="inline-flex items-center justify-center border border-white text-white text-sm font-semibold px-8 py-4 hover:bg-white/10 transition-colors"
              data-testid="hero-cta-secondary"
            >
              {t.ctaSecondary}
            </a>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 animate-bounce">
        <ArrowDown size={20} className="text-white/60" />
      </div>
    </section>
  );
};

export default Hero;
