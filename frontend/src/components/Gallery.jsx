import { useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";

const GALLERY_IMAGES = [
  {
    src: "https://images.eventbook.com/_/w:1200/h:800/rt:fill-down/plain/production://public/uploads/rIjoZaMpuvg0nj6VPzAfvEUU6K4dJme7Sjdo9H7z.jpg",
    alt: "THE LOFT – Gesamte Location",
    span: "md:col-span-2 md:row-span-2",
  },
  {
    src: "https://images.eventbook.com/_/w:800/h:600/rt:fill-down/plain/production://public/uploads/ipBZnzbafFgF7SVdXVc2mNUAldYgjlFEidiHAlcS.jpg",
    alt: "THE LOFT – Indoor Loftraum",
    span: "",
  },
  {
    src: "https://images.eventbook.com/_/w:800/h:600/rt:fill-down/plain/production://public/uploads/j5Wy4b7jsj4UdIwCUC6wdSlQmi7Q1y2OWbqPQiHe.jpg",
    alt: "THE LOFT – Outdoor Dachterrasse",
    span: "",
  },
  {
    src: "https://vz-74fab860-61b.b-cdn.net/0f1c7193-0901-4f6e-934e-0a2e975dac85/thumbnail.jpg",
    alt: "THE LOFT – Video Thumbnail",
    span: "",
  },
  {
    src: "https://images.pexels.com/photos/6044645/pexels-photo-6044645.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940",
    alt: "THE LOFT – Studio Setup",
    span: "",
  },
  {
    src: "https://images.pexels.com/photos/9300740/pexels-photo-9300740.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940",
    alt: "THE LOFT – Meeting Space",
    span: "",
  },
];

const Gallery = () => {
  const { lang } = useLanguage();
  const t = translations[lang].gallery;
  const sectionRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("visible", e.isIntersecting)),
      { threshold: 0.08 }
    );
    sectionRef.current?.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [lang]);

  return (
    <section id="gallery" className="py-24 sm:py-32 bg-white" ref={sectionRef} data-testid="gallery-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="mb-16">
          <p className="overline-text reveal">{t.overline}</p>
          <div className="section-divider reveal" />
          <h2
            className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight reveal"
            style={{ fontFamily: "'Cormorant Garamond', serif" }}
            data-testid="gallery-title"
          >
            {t.title}
          </h2>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 auto-rows-[220px]">
          {GALLERY_IMAGES.map((img, i) => (
            <div
              key={i}
              className={`img-zoom overflow-hidden bg-zinc-100 reveal ${img.span}`}
              style={{ transitionDelay: `${i * 0.08}s` }}
              data-testid={`gallery-image-${i}`}
            >
              <img
                src={img.src}
                alt={img.alt}
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.target.src = "https://images.pexels.com/photos/29252608/pexels-photo-29252608.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940";
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Gallery;
