const COOKIE = "hydoabi_tutorial";
const VERSION = "1";

export function startTutorial(button, steps) {
  const seen = () => document.cookie.split(";").some(part => part.trim() === COOKIE + "=" + VERSION);
  const card = document.createElement("section");
  card.className = "tutorial-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-labelledby", "tutorial-title");
  card.setAttribute("aria-describedby", "tutorial-body");
  card.hidden = true;
  card.innerHTML = '<div class="tutorial-top"><span id="tutorial-count"></span>' +
    '<button type="button" class="icon-button subtle" data-tour="close" aria-label="Dismiss tutorial">' +
    '<svg aria-hidden="true"><use href="#i-close"/></svg></button></div>' +
    '<h2 id="tutorial-title"></h2><p id="tutorial-body"></p>' +
    '<div class="tutorial-actions"><button type="button" class="tutorial-skip" data-tour="skip">Skip tour</button>' +
    '<div><button type="button" class="icon-button" data-tour="back" aria-label="Previous step">' +
    '<svg aria-hidden="true"><use href="#i-arrow"/></svg></button>' +
    '<button type="button" class="button primary" data-tour="next">Next</button></div></div>';
  document.body.append(card);
  let index = 0;
  let active;
  let previousDescription;
  let previousFocus;
  let frame;

  function clearTarget() {
    if (!active) return;
    active.classList.remove("tutorial-target");
    if (previousDescription) active.setAttribute("aria-describedby", previousDescription);
    else active.removeAttribute("aria-describedby");
    active = undefined;
  }

  function finish(restoreFocus = true) {
    if (card.hidden) return;
    clearTarget();
    card.hidden = true;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = COOKIE + "=" + VERSION + "; Max-Age=31536000; Path=/; SameSite=Lax" + secure;
    cancelAnimationFrame(frame);
    if (restoreFocus) {
      const focus = previousFocus?.isConnected &&
        previousFocus.matches("a[href],button,input,select,textarea,[tabindex]") ? previousFocus : button;
      focus?.focus({ preventScroll: true });
    }
  }

  function position() {
    if (card.hidden || !active) return;
    const target = active.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = 12;
    const gap = 12;
    let top = target.bottom + gap;
    if (top + bounds.height > height - margin) top = target.top - bounds.height - gap;
    card.style.top = Math.max(margin, Math.min(height - bounds.height - margin, top)) + "px";
    card.style.left = Math.max(margin, Math.min(width - bounds.width - margin, target.left)) + "px";
  }

  function schedulePosition() {
    if (card.hidden) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(position);
  }

  function render() {
    clearTarget();
    const step = steps[index];
    const target = document.querySelector(step.target);
    if (!target) { finish(); return; }
    active = target;
    previousDescription = active.getAttribute("aria-describedby");
    active.classList.add("tutorial-target");
    active.setAttribute("aria-describedby", [previousDescription, "tutorial-body"].filter(Boolean).join(" "));
    card.querySelector("#tutorial-count").textContent = (index + 1) + " of " + steps.length;
    card.querySelector("#tutorial-title").textContent = step.title;
    card.querySelector("#tutorial-body").textContent = step.body;
    card.querySelector('[data-tour="back"]').disabled = index === 0;
    card.querySelector('[data-tour="next"]').textContent = index === steps.length - 1 ? "Got it" : "Next";
    active.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    position();
    card.querySelector('[data-tour="next"]').focus({ preventScroll: true });
  }

  function open() {
    if (!card.hidden) return;
    previousFocus = document.activeElement;
    if (location.hash !== "#workspace") location.hash = "workspace";
    document.querySelectorAll("[data-page]").forEach(page => { page.hidden = page.id !== "workspace"; });
    index = 0;
    card.hidden = false;
    render();
  }

  card.addEventListener("click", event => {
    const action = event.target.closest("[data-tour]")?.dataset.tour;
    if (action === "close" || action === "skip") finish();
    if (action === "back" && index > 0) { index--; render(); }
    if (action === "next") {
      if (index === steps.length - 1) finish();
      else { index++; render(); }
    }
  });
  button.addEventListener("click", open);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !card.hidden) { event.preventDefault(); finish(); }
  });
  window.addEventListener("resize", schedulePosition);
  document.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("hashchange", () => {
    if (location.hash && location.hash !== "#workspace") finish(false);
  });
  window.addEventListener("pagehide", () => finish(false));
  if (!seen() && !document.getElementById("workspace").hidden) open();
  return { open, finish };
}
