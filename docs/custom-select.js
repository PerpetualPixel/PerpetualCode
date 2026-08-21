/**
 * Themed dropdowns, built on top of a real <select>.
 *
 * A native <select>'s open option list is drawn by the browser/OS and can't
 * be reached by this page's stylesheet (see the color-scheme note on
 * `select` in styles.css) — so on a near-black page it opens as a bright
 * system menu. #slateEventSelect already worked around that with a
 * hand-rolled button + listbox in app.html; this is that same pattern
 * generalised so the other selects can use it without another copy.
 *
 * The <select> stays the source of truth exactly as it does there: it's
 * moved out of sight (sr-only, so it keeps working for keyboard and screen
 * reader users) and picking an option here just sets its value and fires
 * 'change'. Every existing listener keeps working untouched, and any code
 * that writes `select.value` and re-renders keeps working too — call
 * `refresh()` afterward, or fire 'change', and the button follows.
 *
 * Not yet used for #slateEventSelect itself: that one's option list is
 * rebuilt by renderSlateEventOptions on every slate render and carries its
 * own markup in app.html. It could migrate here later; this deliberately
 * doesn't touch it while it's working.
 */

const CARET = `<svg class="custom-select-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Give one <select> a themed button + listbox. Returns a handle with
 * `refresh()` (re-read the select's options and selected value) and
 * `destroy()`, or null when the element isn't there.
 */
export function enhanceSelect(select, { label } = {}) {
  if (!select || select.dataset.enhanced === '1') return null;
  select.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'custom-select';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (label) btn.setAttribute('aria-label', label);

  const menu = document.createElement('ul');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.append(btn, menu);
  select.after(wrap);
  select.classList.add('sr-only');

  function refresh() {
    const options = [...select.options];
    const active = options.find((o) => o.value === select.value) ?? options[0];
    btn.innerHTML = `<span class="custom-select-value">${esc(active?.textContent ?? '')}</span>${CARET}`;
    menu.innerHTML = options
      .map((o) => `<li role="option" class="custom-select-option${
        o.value === select.value ? ' is-selected' : ''
      }" aria-selected="${o.value === select.value}" data-value="${esc(o.value)}">${
        esc(o.textContent)
      }</li>`)
      .join('');
  }

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  function open() {
    if (!menu.hidden) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(value) {
    if (value == null || value === select.value) return close();
    select.value = value;
    // The select stays the thing that owns the change — every listener
    // already bound to it fires exactly as it did before this wrapper.
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
    close();
  }

  btn.addEventListener('click', () => (menu.hidden ? open() : close()));

  menu.addEventListener('click', (event) => {
    const opt = event.target.closest('[data-value]');
    if (opt) choose(opt.dataset.value);
  });

  /* Arrow keys move the selection the way they would on the native control
     this is standing in for; Escape closes without changing anything. */
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return close();
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (menu.hidden) return open();
    const values = [...select.options].map((o) => o.value);
    const at = values.indexOf(select.value);
    const next = event.key === 'ArrowDown'
      ? Math.min(values.length - 1, at + 1)
      : Math.max(0, at - 1);
    choose(values[next]);
    btn.focus();
  });

  const onDocClick = (event) => { if (!wrap.contains(event.target)) close(); };
  document.addEventListener('click', onDocClick);

  // Keeps the button honest when something else sets the value — the sport
  // filter is repopulated from whatever sports the tracker data turns out
  // to contain, for instance.
  select.addEventListener('change', refresh);

  refresh();

  return {
    refresh,
    destroy() {
      document.removeEventListener('click', onDocClick);
      select.removeEventListener('change', refresh);
      select.classList.remove('sr-only');
      delete select.dataset.enhanced;
      wrap.remove();
    },
  };
}
