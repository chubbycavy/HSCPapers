// Runs before paint; CSP allows self-hosted scripts, never inline handlers.
try {
  document.documentElement.dataset.theme = localStorage.getItem("hsc-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch {}
