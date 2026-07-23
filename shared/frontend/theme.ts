export type Theme = "light" | "dark" | "system";

export function themeCookieString(theme: Theme): string {
  return `theme=${theme}; path=/; max-age=31536000; secure; samesite=lax; domain=uni-scrm.com`;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", isDark);
  } else {
    root.classList.toggle("dark", theme === "dark");
  }
  localStorage.setItem("theme", theme);
  document.cookie = themeCookieString(theme);
}

export function getTheme(): Theme {
  return (localStorage.getItem("theme") as Theme) || "system";
}

export function initTheme(): void {
  applyTheme(getTheme());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getTheme() === "system") applyTheme("system");
  });
}
