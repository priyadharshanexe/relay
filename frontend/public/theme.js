// Applies the saved light/dark choice before the page draws, so it never
// flashes the wrong theme. A separate file (not inline) so a strict
// Content-Security-Policy (script-src 'self') still allows it.
try {
  var theme = localStorage.getItem("relay.theme");
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
} catch (error) {
  document.documentElement.dataset.theme = "dark";
}
