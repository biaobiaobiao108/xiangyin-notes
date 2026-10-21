import elephantIcon from "./brand-mark.webp" with { type: "file" };

export function BrandMark({ size = "default", className = "" }: { size?: "default" | "small"; className?: string }) {
  return <img className={`brand-mark ${size === "small" ? "brand-mark--small" : ""} ${className}`.trim()} src={elephantIcon} alt="" aria-hidden="true" />;
}
