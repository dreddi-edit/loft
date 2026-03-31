import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";

const Footer = () => {
  const { lang } = useLanguage();
  const t = translations[lang].footer;

  return (
    <footer className="bg-zinc-900 text-zinc-400 py-12" data-testid="footer">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          {/* Brand */}
          <div>
            <p
              className="text-white text-lg font-light tracking-[0.15em] uppercase mb-1"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
              data-testid="footer-brand"
            >
              THE LOFT
            </p>
            <p className="text-xs text-zinc-500">{t.tagline}</p>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6">
            {t.links.map((link) => (
              <a
                key={link}
                href="#"
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                data-testid={`footer-link-${link.toLowerCase().replace(/\s/g, "-")}`}
              >
                {link}
              </a>
            ))}
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-zinc-800">
          <p className="text-xs text-zinc-600" data-testid="footer-copy">{t.copy}</p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
