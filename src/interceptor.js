(() => {
  const MSG_TYPE = '__sn_poc_interceptor_payload__';
  const MAX_BODY_SIZE = 2 * 1024 * 1024;
  const DEBUG = '[SN-POC][INT]';

  function postPayload(payload) {
    window.postMessage({ type: MSG_TYPE, payload }, window.location.origin);
  }

  function truncateBody(text) {
    if (typeof text !== 'string') {
      return { body: '', truncated: false };
    }
    if (text.length <= MAX_BODY_SIZE) {
      return { body: text, truncated: false };
    }
    return { body: text.slice(0, MAX_BODY_SIZE), truncated: true };
  }

  function isRelevantPath(pathname) {
    return pathname.includes('/sales-api/salesApiProfiles/') ||
      pathname.includes('/sales-api/salesApiPeopleSearch') ||
      pathname.includes('/sales-api/salesApiLeadSearch') ||
      pathname.includes('/sales-api/salesApiCompanies/') ||
      pathname.includes('/sales-api/salesApiLists') ||
      pathname.includes('/sales-api/salesApiLeads');
  }

  function tryParseUrl(input) {
    try {
      return new URL(input, window.location.origin);
    } catch (err) {
      return null;
    }
  }

  async function readXhrBody(xhr) {
    try {
      const rt = xhr.responseType || '';
      if (rt === '' || rt === 'text') {
        return typeof xhr.responseText === 'string' ? xhr.responseText : '';
      }
      if (rt === 'json') {
        try {
          return JSON.stringify(xhr.response ?? null);
        } catch {
          return '';
        }
      }
      if (rt === 'blob') {
        const blob = xhr.response;
        if (!blob) return '';
        return await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
          fr.onerror = () => resolve('');
          fr.readAsText(blob);
        });
      }
      if (rt === 'arraybuffer') {
        const ab = xhr.response;
        if (!(ab instanceof ArrayBuffer)) return '';
        try {
          return new TextDecoder('utf-8').decode(new Uint8Array(ab));
        } catch {
          return '';
        }
      }
      return '';
    } catch {
      return '';
    }
  }

  console.log(DEBUG, 'Interceptor active');

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__snPocMethod = method;
    this.__snPocUrl = url;
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('loadend', function() {
      (async () => {
        try {
        const targetUrl = this.responseURL || this.__snPocUrl;
        const parsedUrl = tryParseUrl(targetUrl);
        if (!parsedUrl || !isRelevantPath(parsedUrl.pathname)) {
          return;
        }

        const raw = await readXhrBody(this);
        const { body, truncated } = truncateBody(raw);

        console.log(DEBUG, 'XHR matched', parsedUrl.pathname, this.status);
        postPayload({
          source: 'xhr',
          method: this.__snPocMethod || 'GET',
          url: parsedUrl.toString(),
          path: parsedUrl.pathname,
          status: this.status,
          body,
          truncated,
          ts: Date.now()
        });
      } catch (err) {
        console.error(DEBUG, 'XHR capture error', String(err));
      }
      })();
    });

    return originalXhrSend.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = async function() {
    const response = await originalFetch.apply(this, arguments);

    try {
      const requestInput = arguments[0];
      const requestInit = arguments[1] || {};

      let requestUrl = '';
      if (typeof requestInput === 'string') {
        requestUrl = requestInput;
      } else if (requestInput && typeof requestInput.url === 'string') {
        requestUrl = requestInput.url;
      }

      const parsedUrl = tryParseUrl(requestUrl || response.url || '');
      if (!parsedUrl || !isRelevantPath(parsedUrl.pathname)) {
        return response;
      }

      const clone = response.clone();
      const text = await clone.text();
      const { body, truncated } = truncateBody(text);

      console.log(DEBUG, 'Fetch matched', parsedUrl.pathname, response.status);
      postPayload({
        source: 'fetch',
        method: (requestInit.method || 'GET').toUpperCase(),
        url: parsedUrl.toString(),
        path: parsedUrl.pathname,
        status: response.status,
        body,
        truncated,
        ts: Date.now()
      });
    } catch (err) {
      console.error(DEBUG, 'Fetch capture error', err);
    }

    return response;
  };
})();
