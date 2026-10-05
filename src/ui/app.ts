// App shell: tab navigation (keyboard friendly), theme toggle, service
// worker registration, and lazy controller boot.

import { ReceiveController } from './receive.js';
import { SendController } from './send.js';

const THEME_KEY = 'arkqr-theme';

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    btn.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b1020' : '#ffffff');
}

function initTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') {
    applyTheme(stored);
  } else {
    applyTheme(
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    );
  }
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function initTabs(): void {
  const tabs = [
    document.getElementById('tab-send'),
    document.getElementById('tab-receive'),
  ];
  const panels = [
    document.getElementById('panel-send'),
    document.getElementById('panel-receive'),
  ];
  if (tabs.some((t) => !t) || panels.some((p) => !p)) return;

  const select = (index: number): void => {
    tabs.forEach((t, i) => {
      t?.setAttribute('aria-selected', String(i === index));
      t?.setAttribute('tabindex', i === index ? '0' : '-1');
    });
    panels.forEach((p, i) => {
      if (p) p.hidden = i !== index;
    });
  };

  tabs.forEach((tab, i) => {
    tab?.addEventListener('click', () => {
      select(i);
      tab.focus();
    });
    tab?.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const next =
        ev.key === 'ArrowRight'
          ? (i + 1) % tabs.length
          : (i + tabs.length - 1) % tabs.length;
      select(next);
      tabs[next]?.focus();
    });
  });
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err: unknown) => {
      console.warn('Service worker registration failed (offline mode unavailable):', err);
    });
  });
}

export function initApp(): void {
  initTheme();
  initTabs();
  registerServiceWorker();
  new SendController().init();
  void new ReceiveController().init();
}
