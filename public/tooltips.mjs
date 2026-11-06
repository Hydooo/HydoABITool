let tooltipCounter = 0;

export function attachTooltips(doc = document) {
  const view = doc.defaultView;
  const tip = doc.createElement("div");
  tip.id = "hydo-tooltip-" + ++tooltipCounter;
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  doc.body.append(tip);
  let target;
  let originalDescription;
  let timer;

  function hide() {
    clearTimeout(timer);
    tip.hidden = true;
    if (target) {
      if (originalDescription) target.setAttribute("aria-describedby", originalDescription);
      else target.removeAttribute("aria-describedby");
    }
    target = undefined;
  }

  function show(element, immediate) {
    if (target === element) return;
    hide();
    if (!element?.dataset.tooltip || element.disabled) return;
    target = element;
    originalDescription = target.getAttribute("aria-describedby");
    timer = setTimeout(() => {
      if (target !== element || !element.isConnected) return;
      tip.textContent = element.dataset.tooltip;
      tip.hidden = false;
      const rect = element.getBoundingClientRect();
      const bounds = tip.getBoundingClientRect();
      const left = Math.max(8, Math.min(view.innerWidth - bounds.width - 8, rect.left + (rect.width - bounds.width) / 2));
      const below = rect.bottom + 8;
      const top = below + bounds.height < view.innerHeight - 8 ? below : Math.max(8, rect.top - bounds.height - 8);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
      element.setAttribute("aria-describedby", [originalDescription, tip.id].filter(Boolean).join(" "));
    }, immediate ? 0 : 300);
  }

  doc.addEventListener("pointerover", event => {
    if (event.pointerType !== "touch") show(event.target.closest?.("[data-tooltip]"), false);
  });
  doc.addEventListener("pointerout", event => {
    if (target && !target.contains(event.relatedTarget)) hide();
  });
  doc.addEventListener("focusin", event => show(event.target.closest?.("[data-tooltip]"), true));
  doc.addEventListener("focusout", hide);
  doc.addEventListener("pointerdown", hide);
  doc.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  view.addEventListener("resize", hide);
  doc.addEventListener("scroll", hide, true);
}
