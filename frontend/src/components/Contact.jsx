import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { MapPin, Clock, User } from "lucide-react";

const Contact = () => {
  const { lang } = useLanguage();
  const t = translations[lang].contact;
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
    <section id="contact" className="py-24 sm:py-32 bg-zinc-50" ref={sectionRef} data-testid="contact-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
          {/* Left: Info */}
          <div>
            <p className="overline-text reveal">{t.overline}</p>
            <div className="section-divider reveal" />
            <h2
              className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight mb-12 reveal"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
              data-testid="contact-title"
            >
              {t.title}
            </h2>

            <div className="space-y-8">
              {/* Address */}
              <div className="flex items-start gap-4 reveal">
                <MapPin size={18} className="text-zinc-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{t.address}</p>
                  <p className="text-sm text-zinc-500">{t.city}</p>
                </div>
              </div>

              {/* Hours */}
              <div className="flex items-start gap-4 reveal">
                <Clock size={18} className="text-zinc-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{t.hours}</p>
                  <p className="text-sm text-zinc-500">{t.hoursNote}</p>
                </div>
              </div>

              {/* Person */}
              <div className="flex items-start gap-4 reveal">
                <User size={18} className="text-zinc-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900">{t.person}</p>
                </div>
              </div>
            </div>

            <div className="mt-10 reveal">
              <a
                href="#booking"
                className="inline-flex items-center bg-zinc-900 text-white text-sm font-medium px-8 py-4 hover:bg-zinc-700 transition-colors"
                data-testid="contact-cta"
              >
                {t.cta}
              </a>
            </div>
          </div>

          {/* Right: Map */}
          <div className="reveal sharp-card overflow-hidden h-80 sm:h-96 lg:h-[480px] bg-zinc-200" data-testid="contact-map">
            <iframe
              title="THE LOFT Düsseldorf"
              src="https://www.openstreetmap.org/export/embed.html?bbox=6.754%2C51.213%2C6.784%2C51.223&layer=mapnik&marker=51.218%2C6.769"
              width="100%"
              height="100%"
              style={{ border: 0, filter: "grayscale(30%) contrast(105%)" }}
              allowFullScreen
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </div>
    </section>
  );
};

export default Contact;
