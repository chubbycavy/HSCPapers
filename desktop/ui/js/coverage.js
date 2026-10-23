(() => {
  "use strict";
  const tip = document.getElementById("covtip");
  if (!tip) return;
  for (const td of document.querySelectorAll("table.matrix td[data-label]")) {
    td.addEventListener("mouseenter", () => { tip.textContent = td.dataset.label; tip.style.display = "block"; });
    td.addEventListener("mousemove", event => {
      tip.style.left = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(8, event.clientY - 34) + "px";
    });
    td.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }
})();
