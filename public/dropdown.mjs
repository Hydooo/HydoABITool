export class Dropdown {
  constructor(root, onChange) {
    this.button = root.querySelector("button");
    this.label = this.button.querySelector("[data-value]");
    this.menu = root.querySelector("[role=listbox]");
    this.onChange = onChange;
    this.items = [];
    this.value = "";
    this.active = 0;
    this.search = "";
    this.searchTime = 0;

    this.button.addEventListener("click", () => this.menu.hidden ? this.open() : this.close());
    this.button.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.open();
      }
    });
    this.menu.addEventListener("keydown", event => this.keydown(event));
    root.addEventListener("focusout", event => {
      if (!root.contains(event.relatedTarget)) this.close();
    });
    document.addEventListener("pointerdown", event => {
      if (!root.contains(event.target)) this.close();
    });
  }

  setOptions(items, value) {
    this.items = items;
    this.value = items.some(item => item.value === value) ? value : items[0]?.value ?? "";
    this.menu.replaceChildren(...items.map((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(item.value === this.value));
      option.tabIndex = -1;
      option.textContent = item.label;
      option.addEventListener("click", () => this.select(index));
      return option;
    }));
    this.label.textContent = items.find(item => item.value === this.value)?.label ?? "Choose";
    this.close();
  }

  open() {
    if (!this.items.length || !this.menu.hidden) return;
    this.menu.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.focus(Math.max(0, this.items.findIndex(item => item.value === this.value)));
  }

  close(restoreFocus = false) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.search = "";
    if (restoreFocus) this.button.focus();
  }

  focus(index) {
    this.active = (index + this.items.length) % this.items.length;
    this.menu.children[this.active]?.focus();
  }

  select(index) {
    const item = this.items[index];
    const changed = item.value !== this.value;
    this.value = item.value;
    this.label.textContent = item.label;
    [...this.menu.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
    this.close(true);
    if (changed) this.onChange(this.value);
  }

  keydown(event) {
    switch (event.key) {
      case "Escape": event.preventDefault(); this.close(true); return;
      case "ArrowDown": event.preventDefault(); this.focus(this.active + 1); return;
      case "ArrowUp": event.preventDefault(); this.focus(this.active - 1); return;
      case "Home": event.preventDefault(); this.focus(0); return;
      case "End": event.preventDefault(); this.focus(this.items.length - 1); return;
      case "Tab":
        this.close(true);
        return;
    }
    if (event.key.length !== 1 || !/[a-z\d]/i.test(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    const now = performance.now();
    this.search = (now - this.searchTime > 650 ? "" : this.search) + event.key.toLowerCase();
    this.searchTime = now;
    const first = this.items.findIndex(item => item.label.toLowerCase().startsWith(this.search));
    if (first >= 0) this.focus(first);
  }
}
