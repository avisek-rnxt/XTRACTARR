(() => {
  if (globalThis.__xtractarrContentBound) {
    return;
  }
  globalThis.__xtractarrContentBound = true;

  const MSG_TYPE = '__sn_poc_interceptor_payload__';
  const DEBUG = '[XTRACTARR][CS]';

  const ext =
    (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome : null) ||
    (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id ? browser : null);

  function isContextInvalidatedError(value) {
    const msg = String(value || '');
    return msg.toLowerCase().includes('extension context invalidated');
  }

  function injectInterceptor() {
    try {
      if (!ext?.runtime?.getURL) {
        return;
      }

      if (document.documentElement.dataset.snPocInjected === '1') {
        return;
      }
      document.documentElement.dataset.snPocInjected = '1';

      const script = document.createElement('script');
      script.src = ext.runtime.getURL('src/interceptor.js');
      script.onload = () => script.remove();
      script.onerror = () => console.error(DEBUG, 'Interceptor injection failed');
      (document.head || document.documentElement).appendChild(script);
    } catch (err) {
      if (!isContextInvalidatedError(err)) {
        console.error(DEBUG, 'injectInterceptor error', String(err));
      }
    }
  }

  function getLinkedinCsrfToken() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)JSESSIONID=([^;]+)/);
      return m?.[1] || '';
    } catch {
      return '';
    }
  }

  function safeSendMessage(payload) {
    try {
      if (!ext?.runtime?.sendMessage) {
        return;
      }

      ext.runtime.sendMessage(payload, (res) => {
        try {
          const lastError = ext.runtime?.lastError;
          if (lastError) {
            if (!isContextInvalidatedError(lastError.message)) {
              console.debug(DEBUG, 'sendMessage lastError:', lastError.message);
            }
            return;
          }
          void res;
        } catch (err) {
          if (!isContextInvalidatedError(err)) {
            console.debug(DEBUG, 'sendMessage callback error:', String(err));
          }
        }
      });
    } catch (err) {
      if (!isContextInvalidatedError(err)) {
        console.error(DEBUG, 'sendMessage exception', String(err));
      }
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findNextButton() {
    const selectors = [
      'button.artdeco-pagination__button--next',
      'button[aria-label="Next"]',
      'button[aria-label*="Next"]',
      'button.search-results__pagination-next-button',
      'a[aria-label="Next"]',
      'a[aria-label*="Next"]'
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const ariaDisabled = String(node.getAttribute('aria-disabled') || '').toLowerCase();
        const disabled = node.disabled || ariaDisabled === 'true' || node.classList.contains('disabled');
        if (!disabled && isVisible(node)) {
          return node;
        }
      }
    }
    return null;
  }

  function goToNextPage() {
    const nextBtn = findNextButton();
    if (!nextBtn) {
      return { moved: false, reason: 'next_button_not_found_or_disabled' };
    }
    nextBtn.click();
    return { moved: true };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getScrollableRoot() {
    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      const canScroll = /(auto|scroll)/i.test(style.overflowY || '');
      return canScroll && el.scrollHeight > el.clientHeight + 24;
    });

    if (candidates.length === 0) {
      return document.scrollingElement || document.documentElement;
    }

    const ranked = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return ranked[0];
  }

  function getScrollTop(target) {
    if (target === document.documentElement || target === document.body || target === document.scrollingElement) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return target.scrollTop || 0;
  }

  function getScrollMetrics(target) {
    if (target === document.documentElement || target === document.body || target === document.scrollingElement) {
      const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      return { scrollHeight: height, clientHeight: window.innerHeight };
    }
    return { scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
  }

  function setScrollTop(target, value) {
    if (target === document.documentElement || target === document.body || target === document.scrollingElement) {
      window.scrollTo({ top: value, behavior: 'auto' });
      return;
    }
    target.scrollTop = value;
  }

  async function scrollPageToBottom(maxMs = 18000) {
    const target = getScrollableRoot();
    const startedAt = Date.now();
    let stableTicks = 0;
    let lastTop = -1;

    while (Date.now() - startedAt < maxMs) {
      const { scrollHeight, clientHeight } = getScrollMetrics(target);
      const currentTop = getScrollTop(target);
      const maxTop = Math.max(0, scrollHeight - clientHeight);
      const atBottom = currentTop >= maxTop - 2;

      if (!atBottom) {
        setScrollTop(target, maxTop);
      }

      await wait(450);

      const updatedTop = getScrollTop(target);
      const unchanged = Math.abs(updatedTop - lastTop) < 2;
      const nowBottom = updatedTop >= Math.max(0, getScrollMetrics(target).scrollHeight - getScrollMetrics(target).clientHeight) - 2;

      if (unchanged && nowBottom) {
        stableTicks += 1;
      } else if (nowBottom) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
      }

      lastTop = updatedTop;
      if (stableTicks >= 3) break;
    }

    return { ok: true, scrolled: true, position: getScrollTop(target) };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== MSG_TYPE || !event.data.payload) return;

    safeSendMessage({
      type: 'SN_CAPTURE',
      pageUrl: window.location.href,
      csrfToken: getLinkedinCsrfToken(),
      payload: event.data.payload
    });
  });

  if (ext?.runtime?.onMessage?.addListener) {
    ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || (message.type !== 'XTRACTARR_NEXT_PAGE' && message.type !== 'XTRACTARR_ADVANCE_PAGE' && message.type !== 'XTRACTARR_SCROLL_BOTTOM')) {
        return;
      }

      (async () => {
        try {
          if (message.type === 'XTRACTARR_SCROLL_BOTTOM') {
            const scrolled = await scrollPageToBottom();
            sendResponse({ ok: true, ...scrolled, pageUrl: window.location.href });
            return;
          }
          if (message.type === 'XTRACTARR_ADVANCE_PAGE') {
            await scrollPageToBottom();
            await wait(2000);
          }
          const result = goToNextPage();
          sendResponse({ ok: true, ...result, pageUrl: window.location.href });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    });
  }

  injectInterceptor();
})();
