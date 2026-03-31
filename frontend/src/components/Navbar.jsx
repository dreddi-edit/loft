import { useState, useEffect } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { Menu, X } from "lucide-react";

const Navbar = () => {
  const { lang, toggle } = useLanguage();
  const t = translations[lang].nav;
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navLinks = [
    { label: t.about, href: "#about" },
    { label: t.spaces, href: "#spaces" },
    { label: t.events, href: "#events" },
    { label: t.amenities, href: "#amenities" },
    { label: t.gallery, href: "#gallery" },
    { label: t.pricing, href: "#pricing" },
    { label: t.contact, href: "#contact" },
  ];

  return (
    <nav
      className={`fixed top-0 w-full z-50 transition-all duration-300 ${
        scrolled ? "bg-white/95 backdrop-blur-xl border-b border-zinc-200 shadow-sm" : "bg-transparent"
      }`}
      data-testid="navbar"
    >
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="flex items-center justify-between h-16 sm:h-20">
          {/* Logo */}
          <a
            href="#"
            className={`font-heading text-xl font-light tracking-[0.15em] uppercase transition-colors ${
              scrolled ? "text-zinc-900" : "text-white"
            }`}
            data-testid="nav-logo"
          >
            THE LOFT
          </a>

          {/* Desktop Links */}
          <div className="hidden lg:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={`nav-link text-sm font-medium transition-colors ${
                  scrolled ? "text-zinc-600 hover:text-zinc-900" : "text-white/90 hover:text-white"
                }`}
                data-testid={`nav-${link.href.replace("#", "")}-link`}
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Right: Language + CTA */}
          <div className="hidden lg:flex items-center gap-4">
            <button
              onClick={toggle}
              className={`text-xs font-semibold tracking-widest uppercase transition-colors ${
                scrolled ? "text-zinc-500 hover:text-zinc-900" : "text-white/70 hover:text-white"
              }`}
              data-testid="language-toggle"
            >
              {lang === "de" ? "EN" : "DE"}
            </button>
            <a
              href="#booking"
              className="bg-zinc-900 text-white text-sm font-medium px-6 py-2.5 hover:bg-zinc-700 transition-colors"
              data-testid="nav-booking-cta"
            >
              {translations[lang].nav.booking}
            </a>
          </div>

          {/* Mobile */}
          <div className="flex lg:hidden items-center gap-4">
            <button
              onClick={toggle}
              className={`text-xs font-semibold tracking-widest uppercase ${
                scrolled ? "text-zinc-500" : "text-white/70"
              }`}
              data-testid="language-toggle-mobile"
            >
              {lang === "de" ? "EN" : "DE"}
            </button>
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className={scrolled ? "text-zinc-900" : "text-white"}
              data-testid="hamburger-menu"
            >
              {mobileOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>

        {/* Mobile Menu */}
        {mobileOpen && (
          <div className="lg:hidden bg-white border-t border-zinc-100 py-4 space-y-1">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block px-4 py-3 text-sm text-zinc-700 hover:text-zinc-900 hover:bg-zinc-50"
                data-testid={`mobile-nav-${link.href.replace("#", "")}-link`}
              >
                {link.label}
              </a>
            ))}
            <div className="px-4 pt-2">
              <a
                href="#booking"
                onClick={() => setMobileOpen(false)}
                className="block w-full text-center bg-zinc-900 text-white text-sm font-medium py-3 hover:bg-zinc-700 transition-colors"
                data-testid="mobile-nav-booking-cta"
              >
                {translations[lang].nav.booking}
              </a>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
