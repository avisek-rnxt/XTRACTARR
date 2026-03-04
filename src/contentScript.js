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

  injectInterceptor();
})();