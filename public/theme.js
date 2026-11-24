// Applies the saved light/dark choice before the page paints (no flash).
try { const t = localStorage.getItem("gr-theme"); document.documentElement.dataset.theme = t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
catch (e) { document.documentElement.dataset.theme = "light"; }
