import { useState, useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { translations } from "@/translations";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { CalendarIcon, AlertCircle } from "lucide-react";
import axios from "axios";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const Booking = () => {
  const { lang } = useLanguage();
  const t = translations[lang].booking;
  const sectionRef = useRef(null);

  const [date, setDate] = useState(null);
  const [eventType, setEventType] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({ name: "", company: "", email: "", phone: "", guests: "", message: "" });

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("visible", e.isIntersecting)),
      { threshold: 0.08 }
    );
    sectionRef.current?.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [lang]);

  const handleChange = (e) => setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !eventType || !date || !time || !duration || !form.guests) {
      toast.error(lang === "de" ? "Bitte alle Pflichtfelder ausfüllen." : "Please fill all required fields.");
      return;
    }
    setIsSubmitting(true);
    try {
      await axios.post(`${API}/bookings`, {
        name: form.name,
        company: form.company,
        email: form.email,
        phone: form.phone,
        event_type: eventType,
        date: format(date, "yyyy-MM-dd"),
        time,
        duration,
        guests: parseInt(form.guests) || 1,
        message: form.message,
      });
      toast.success(t.success);
      setForm({ name: "", company: "", email: "", phone: "", guests: "", message: "" });
      setDate(null);
      setEventType("");
      setTime("");
      setDuration("");
    } catch {
      toast.error(t.error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    "w-full border-b border-zinc-300 bg-transparent py-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none transition-colors";

  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const isPast = (d) => d < new Date(new Date().setHours(0, 0, 0, 0));

  return (
    <section id="booking" className="py-24 sm:py-32 bg-white" ref={sectionRef} data-testid="booking-section">
      <div className="max-w-7xl mx-auto px-6 sm:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-16">
          {/* Left Info */}
          <div className="lg:col-span-2">
            <p className="overline-text reveal">{t.overline}</p>
            <div className="section-divider reveal" />
            <h2
              className="text-3xl sm:text-4xl lg:text-5xl font-light leading-tight mb-6 reveal"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
              data-testid="booking-title"
            >
              {t.title}
            </h2>
            <p className="text-base text-zinc-600 mb-8 leading-relaxed reveal">{t.subtitle}</p>
            <div className="flex items-start gap-3 reveal">
              <AlertCircle size={15} className="text-zinc-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-zinc-500 italic">{t.note}</p>
            </div>
          </div>

          {/* Right Form */}
          <form
            onSubmit={handleSubmit}
            className="lg:col-span-3 space-y-8 reveal"
            data-testid="booking-form"
          >
            {/* Row 1: Name + Company */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              <div>
                <label className="overline-text block mb-2">{t.labels.name}</label>
                <input
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  placeholder={t.placeholders.name}
                  className={inputClass}
                  data-testid="booking-name-input"
                />
              </div>
              <div>
                <label className="overline-text block mb-2">{t.labels.company}</label>
                <input
                  name="company"
                  value={form.company}
                  onChange={handleChange}
                  placeholder={t.placeholders.company}
                  className={inputClass}
                  data-testid="booking-company-input"
                />
              </div>
            </div>

            {/* Row 2: Email + Phone */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              <div>
                <label className="overline-text block mb-2">{t.labels.email}</label>
                <input
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  placeholder={t.placeholders.email}
                  className={inputClass}
                  data-testid="booking-email-input"
                />
              </div>
              <div>
                <label className="overline-text block mb-2">{t.labels.phone}</label>
                <input
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  placeholder={t.placeholders.phone}
                  className={inputClass}
                  data-testid="booking-phone-input"
                />
              </div>
            </div>

            {/* Event Type */}
            <div>
              <label className="overline-text block mb-2">{t.labels.eventType}</label>
              <Select onValueChange={setEventType} value={eventType}>
                <SelectTrigger
                  className="w-full border-0 border-b border-zinc-300 rounded-none px-0 py-3 text-sm focus:ring-0 focus:border-zinc-900 bg-transparent"
                  data-testid="booking-event-type-select"
                >
                  <SelectValue placeholder={lang === "de" ? "Anlass wählen ..." : "Select event type ..."} />
                </SelectTrigger>
                <SelectContent>
                  {t.eventTypes.map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Row: Date + Time */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              {/* Date Picker */}
              <div>
                <label className="overline-text block mb-2">{t.labels.date}</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between border-b border-zinc-300 py-3 text-sm text-left focus:border-zinc-900 focus:outline-none transition-colors"
                      data-testid="booking-date-picker"
                    >
                      <span className={date ? "text-zinc-900" : "text-zinc-400"}>
                        {date
                          ? format(date, "dd.MM.yyyy", { locale: lang === "de" ? de : undefined })
                          : t.placeholders.datePicker}
                      </span>
                      <CalendarIcon size={15} className="text-zinc-400" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 rounded-none" align="start">
                    <Calendar
                      mode="single"
                      selected={date}
                      onSelect={setDate}
                      disabled={(d) => isPast(d) || isWeekend(d)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Time */}
              <div>
                <label className="overline-text block mb-2">{t.labels.time}</label>
                <Select onValueChange={setTime} value={time}>
                  <SelectTrigger
                    className="w-full border-0 border-b border-zinc-300 rounded-none px-0 py-3 text-sm focus:ring-0 focus:border-zinc-900 bg-transparent"
                    data-testid="booking-time-select"
                  >
                    <SelectValue placeholder={lang === "de" ? "Uhrzeit ..." : "Time ..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {t.times.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row: Duration + Guests */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              <div>
                <label className="overline-text block mb-2">{t.labels.duration}</label>
                <Select onValueChange={setDuration} value={duration}>
                  <SelectTrigger
                    className="w-full border-0 border-b border-zinc-300 rounded-none px-0 py-3 text-sm focus:ring-0 focus:border-zinc-900 bg-transparent"
                    data-testid="booking-duration-select"
                  >
                    <SelectValue placeholder={lang === "de" ? "Dauer ..." : "Duration ..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {t.durations.map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="overline-text block mb-2">{t.labels.guests}</label>
                <input
                  name="guests"
                  type="number"
                  min="1"
                  max="60"
                  value={form.guests}
                  onChange={handleChange}
                  placeholder="1–60"
                  className={inputClass}
                  data-testid="booking-guests-input"
                />
              </div>
            </div>

            {/* Message */}
            <div>
              <label className="overline-text block mb-2">{t.labels.message}</label>
              <textarea
                name="message"
                value={form.message}
                onChange={handleChange}
                rows={4}
                placeholder={t.placeholders.message}
                className="w-full border border-zinc-200 bg-transparent p-4 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none transition-colors resize-none"
                data-testid="booking-message-textarea"
              />
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-zinc-900 text-white text-sm font-medium py-4 hover:bg-zinc-700 transition-colors disabled:opacity-60"
              data-testid="booking-submit-button"
            >
              {isSubmitting ? t.submitting : t.submit}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
};

export default Booking;
