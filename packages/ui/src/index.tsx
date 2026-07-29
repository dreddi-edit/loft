import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  children: ReactNode;
};

export function Button({ variant = "primary", className, children, ...props }: ButtonProps) {
  return (
    <button className={cn("hs-btn", variant === "primary" ? "hs-btn-primary" : "hs-btn-secondary", className)} {...props}>
      {children}
    </button>
  );
}

type AnchorButtonProps = {
  href: string;
  variant?: "primary" | "secondary";
  className?: string;
  children: ReactNode;
};

export function AnchorButton({ href, variant = "primary", className, children }: AnchorButtonProps) {
  return (
    <a href={href} className={cn("hs-btn", variant === "primary" ? "hs-btn-primary" : "hs-btn-secondary", className)}>
      {children}
    </a>
  );
}

type CardProps = { children: ReactNode; className?: string; style?: CSSProperties };
export function Card({ children, className, style }: CardProps) {
  return <div className={cn("hs-card", className)} style={style}>{children}</div>;
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string };
export function Input({ label, className, id, ...props }: InputProps) {
  const inputId = id ?? props.name;
  return (
    <label className="hs-label" htmlFor={inputId}>
      {label}
      <input id={inputId} className={cn("hs-input", className)} {...props} />
    </label>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: string };
export function Select({ label, className, id, children, ...props }: SelectProps) {
  const selectId = id ?? props.name;
  return (
    <label className="hs-label" htmlFor={selectId}>
      {label}
      <select id={selectId} className={cn("hs-select", className)} {...props}>
        {children}
      </select>
    </label>
  );
}

type BadgeProps = { children: ReactNode };
export function Badge({ children }: BadgeProps) {
  return <span className="hs-badge">{children}</span>;
}

type PageHeaderProps = { title: string; subtitle?: string };
export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <header style={{ marginBottom: "1.5rem" }}>
      <h1 style={{ margin: 0, fontFamily: "var(--hs-font-display)", fontSize: "clamp(2rem, 4vw, 3rem)" }}>{title}</h1>
      {subtitle ? <p style={{ color: "var(--hs-muted)", marginTop: "0.75rem", maxWidth: "680px" }}>{subtitle}</p> : null}
    </header>
  );
}

export function Container({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={cn("hs-container", className)} style={style}>{children}</div>;
}

const brandLogoSources = {
  sm: "/brand/logo.png",
  md: "/brand/logo.png",
  lg: "/brand/logo.png",
} as const;

type BrandLogoProps = {
  alt?: string;
  size?: keyof typeof brandLogoSources;
  tagline?: string;
  className?: string;
  href?: string;
  invert?: boolean;
};

export function BrandLogo({
  alt = "Hair Simo",
  size = "sm",
  tagline,
  className,
  href,
  invert = false,
}: BrandLogoProps) {
  const image = (
    <img
      src={brandLogoSources[size]}
      alt={alt}
      className={cn(
        "hs-brand-logo",
        size === "md" && "hs-brand-logo-md",
        size === "lg" && "hs-brand-logo-lg",
        invert && "hs-brand-logo-invert",
        className,
      )}
      width={size === "sm" ? 160 : 220}
      height={size === "sm" ? 55 : 75}
    />
  );

  const content = (
    <span className="hs-brand">
      {image}
      {tagline ? <span className="hs-brand-tagline">{tagline}</span> : null}
    </span>
  );

  if (href) {
    return (
      <a href={href} className="hs-brand-link">
        {content}
      </a>
    );
  }

  return content;
}

type PartnerLogoProps = {
  src?: string;
  alt?: string;
  className?: string;
  invert?: boolean;
};

export function PartnerLogo({
  src = "/brand/davines-logo-sm.png",
  alt = "Davines",
  className,
  invert = false,
}: PartnerLogoProps) {
  return (
    <div className={cn("hs-partner-logo", className)}>
      <img src={src} alt={alt} className={cn(invert && "hs-brand-logo-invert")} loading="lazy" />
    </div>
  );
}
