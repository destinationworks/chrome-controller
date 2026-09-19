export interface GuardedExtractionOptions {
  selector?: unknown;
  expression?: unknown;
  trapClipboard?: unknown;
  clickSelector?: unknown;
  ttlSeconds?: unknown;
}

export interface GuardedInjectionOptions {
  selector: unknown;
  value: unknown;
}

const PAGE_GUARD_BODY = String.raw`
  const bytes = new TextEncoder().encode(secret);
  const patterns = [secret];
  if (bytes.length >= 4) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const b64 = btoa(binary);
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    patterns.push(b64, b64.replace(/=+$/, ''), b64url, b64url.replace(/=+$/, ''),
      hex, hex.toUpperCase(), Array.from(secret).reverse().join(''));
  }
  const uniquePatterns = [...new Set(patterns)].filter(Boolean)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const preferredReplacement = '[SECURE_CLIPBOARD_REDACTED]';
  let replacement = preferredReplacement;
  if (uniquePatterns.some(pattern => replacement.includes(pattern))) {
    for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
      const candidate = String.fromCodePoint(codePoint).repeat(3);
      if (!uniquePatterns.some(pattern => candidate.includes(pattern) || pattern.includes(candidate))) {
        replacement = candidate;
        break;
      }
    }
  }
  let masked = 0;
  const maskValue = value => {
    let output = String(value);
    for (const pattern of uniquePatterns) {
      if (output.includes(pattern)) output = output.split(pattern).join(replacement);
    }
    if (output !== String(value)) masked += 1;
    return output;
  };
  const containsSensitiveValue = value => uniquePatterns.some(pattern => String(value).includes(pattern));
  const pseudoMaskAttribute = 'data-secure-clipboard-pseudo-mask';
  const styledRoots = new WeakSet();
  const cssReplacement = replacement.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const ensureGuardStyle = root => {
    if (!root || styledRoots.has(root)) return;
    const styleDocument = root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument;
    if (!styleDocument) return;
    const style = styleDocument.createElement('style');
    style.textContent =
      '[' + pseudoMaskAttribute + '~="before"]::before,' +
      '[' + pseudoMaskAttribute + '~="after"]::after {' +
      'content: "' + cssReplacement + '" !important;}';
    try {
      if (root.nodeType === Node.DOCUMENT_NODE) {
        (root.head || root.documentElement).appendChild(style);
      } else if (typeof root.appendChild === 'function') {
        root.appendChild(style);
      }
      styledRoots.add(root);
    } catch (_) {}
  };
  const observedRoots = new WeakSet();
  const guardedRealms = new WeakSet();
  const originalSetterSymbol = Symbol.for('secureClipboard.originalValueSetter');
  const valueGuardStateSymbol = Symbol.for('secureClipboard.valueGuardState');
  const attachShadowStateSymbol = Symbol.for('secureClipboard.attachShadowState');
  const guardExpiresAt = Date.now() + guardTtlSeconds * 1000;
  let observeRoot;
  const installValueGuard = prototype => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor || !descriptor.get || !descriptor.set) return;
    let state = prototype[valueGuardStateSymbol];
    if (!state || state.wrapper !== descriptor.set) {
      const baseSetter = state?.wrapper === descriptor.set ? state.baseSetter : descriptor.set;
      const originalSetter = state?.originalSetter || prototype[originalSetterSymbol] || descriptor.set;
      state = { baseSetter, originalSetter, entries: [] };
      state.wrapper = function(next) {
        const now = Date.now();
        state.entries = state.entries.filter(entry => entry.expiresAt > now);
        let guarded = next;
        for (const entry of state.entries) guarded = entry.mask(guarded);
        state.baseSetter.call(this, guarded);
      };
      if (!prototype[originalSetterSymbol]) {
        Object.defineProperty(prototype, originalSetterSymbol, {
          value: originalSetter,
          configurable: false,
          enumerable: false,
          writable: false,
        });
      }
      Object.defineProperty(prototype, valueGuardStateSymbol, {
        value: state,
        configurable: true,
        enumerable: false,
        writable: true,
      });
      Object.defineProperty(prototype, 'value', {
        ...descriptor,
        set: state.wrapper,
      });
    }
    state.entries = state.entries.filter(entry => entry.expiresAt > Date.now());
    state.entries.push({ mask: maskValue, expiresAt: guardExpiresAt });
  };
  const installRealmGuards = realm => {
    if (!realm || guardedRealms.has(realm)) return;
    guardedRealms.add(realm);
    installValueGuard(realm.HTMLInputElement && realm.HTMLInputElement.prototype);
    installValueGuard(realm.HTMLTextAreaElement && realm.HTMLTextAreaElement.prototype);
    const elementPrototype = realm.Element && realm.Element.prototype;
    const currentAttachShadow = elementPrototype && elementPrototype.attachShadow;
    if (elementPrototype && typeof currentAttachShadow === 'function') {
      let state = elementPrototype[attachShadowStateSymbol];
      if (!state || state.wrapper !== currentAttachShadow) {
        const originalAttachShadow = state?.wrapper === currentAttachShadow
          ? state.original
          : currentAttachShadow;
        state = { original: originalAttachShadow, observers: [] };
        state.wrapper = function(init) {
          const root = state.original.call(this, init);
          const now = Date.now();
          state.observers = state.observers.filter(entry => entry.expiresAt > now);
          for (const entry of state.observers) {
            try { entry.observe(root); } catch (_) {}
          }
          return root;
        };
        Object.defineProperty(elementPrototype, attachShadowStateSymbol, {
          value: state,
          configurable: true,
          enumerable: false,
          writable: true,
        });
        elementPrototype.attachShadow = state.wrapper;
      }
      state.observers = state.observers.filter(entry => entry.expiresAt > Date.now());
      state.observers.push({ observe: observeRoot, expiresAt: guardExpiresAt });
    }
  };
  const scrubNode = node => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const next = maskValue(node.data || '');
      if (next !== node.data) node.data = next;
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const attribute of Array.from(node.attributes || [])) {
        const next = maskValue(attribute.value);
        if (next !== attribute.value) node.setAttribute(attribute.name, next);
      }
      if (typeof node.value === 'string') {
        const next = maskValue(node.value);
        if (next !== node.value) node.value = next;
      }
      const pseudoMatches = [];
      for (const pseudo of ['::before', '::after']) {
        try {
          if (containsSensitiveValue(getComputedStyle(node, pseudo).content || '')) pseudoMatches.push(pseudo.slice(2));
        } catch (_) {}
      }
      if (pseudoMatches.length > 0) node.setAttribute(pseudoMaskAttribute, pseudoMatches.join(' '));
      if (node.shadowRoot) observeRoot(node.shadowRoot);
      if (node.tagName === 'IFRAME') {
        try { if (node.contentDocument) observeRoot(node.contentDocument); } catch (_) {}
        node.addEventListener('load', () => {
          try { if (node.contentDocument) observeRoot(node.contentDocument); } catch (_) {}
        }, { once: true });
      }
    }
    for (const child of Array.from(node.childNodes || [])) scrubNode(child);
    if (node.nodeType === Node.ELEMENT_NODE && node.childNodes && node.childNodes.length > 1 &&
        containsSensitiveValue(node.textContent || '')) {
      node.textContent = maskValue(node.textContent || '');
    }
  };
  observeRoot = root => {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    ensureGuardStyle(root);
    try { installRealmGuards(root.defaultView || root.ownerDocument?.defaultView); } catch (_) {}
    scrubNode(root);
    const RealmMutationObserver = root.defaultView?.MutationObserver ||
      root.ownerDocument?.defaultView?.MutationObserver || MutationObserver;
    const observer = new RealmMutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData' || mutation.type === 'attributes') scrubNode(mutation.target);
        else for (const added of Array.from(mutation.addedNodes || [])) scrubNode(added);
      }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => observer.disconnect(), Math.max(1, guardTtlSeconds * 1000));
  };
  observeRoot(document);
  let residual = 0;
  const inspectNode = node => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE && containsSensitiveValue(node.data || '')) residual += 1;
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const attribute of Array.from(node.attributes || [])) {
        if (containsSensitiveValue(attribute.value)) residual += 1;
      }
      if (typeof node.value === 'string' && containsSensitiveValue(node.value)) residual += 1;
      for (const pseudo of ['::before', '::after']) {
        try { if (containsSensitiveValue(getComputedStyle(node, pseudo).content || '')) residual += 1; } catch (_) {}
      }
      if (node.shadowRoot) inspectNode(node.shadowRoot);
      if (node.tagName === 'IFRAME') {
        try { if (node.contentDocument) inspectNode(node.contentDocument); } catch (_) {}
      }
      if (node.childNodes && node.childNodes.length > 1 && containsSensitiveValue(node.textContent || '')) residual += 1;
    }
    for (const child of Array.from(node.childNodes || [])) inspectNode(child);
  };
  inspectNode(document);
  return { guarded: residual === 0, masked, residual };
`;

export function buildGuardedExtractionExpression(options: GuardedExtractionOptions): string {
  const ttlSeconds = typeof options.ttlSeconds === 'number' && Number.isSafeInteger(options.ttlSeconds) &&
    options.ttlSeconds >= 1 && options.ttlSeconds <= 86400 ? options.ttlSeconds : 300;
  let extraction: string;
  if (options.trapClipboard === true) {
    throw new Error(
      'trapClipboard is disabled because page-level interception cannot guarantee OS clipboard isolation; use selector or expression',
    );
  } else if (typeof options.expression === 'string') {
    extraction = `secret = await (${options.expression});`;
  } else if (typeof options.selector === 'string') {
    extraction = `const element = document.querySelector(${JSON.stringify(options.selector)});\n` +
      'secret = element && (element.value || element.innerText || element.textContent);';
  } else {
    throw new Error('Guarded extraction requires selector or expression; clipboard trapping is disabled');
  }

  return `(async () => {
    let secret = null;
    try { ${extraction} } catch (_) { return { beforeSecret: true }; }
    if (typeof secret !== 'string' || secret.trim().length === 0) return { beforeSecret: true };
    let guard;
    try { guard = ((secret, guardTtlSeconds) => { ${PAGE_GUARD_BODY} })(secret, ${JSON.stringify(ttlSeconds)}); }
    catch (_) { guard = { guarded: false, masked: 0, residual: 1 }; }
    return { secret, guard };
  })()`;
}

export function buildGuardedInjectionExpression(options: GuardedInjectionOptions): string {
  if (typeof options.selector !== 'string' || options.selector.length === 0) {
    throw new Error('Guarded injection requires a non-empty selector');
  }
  if (typeof options.value !== 'string' || options.value.length === 0) {
    throw new Error('Guarded injection requires a non-empty string value');
  }

  const selector = JSON.stringify(options.selector);
  const value = JSON.stringify(options.value);
  return `(() => {
    try {
      const element = document.querySelector(${selector});
      if (!element || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return { injected: false };
      }
      const prototype = element instanceof HTMLTextAreaElement
        ? element.ownerDocument.defaultView.HTMLTextAreaElement.prototype
        : element.ownerDocument.defaultView.HTMLInputElement.prototype;
      const originalSetter = prototype[Symbol.for('secureClipboard.originalValueSetter')];
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      const setter = typeof originalSetter === 'function' ? originalSetter : descriptor && descriptor.set;
      if (typeof setter !== 'function') return { injected: false };
      element.focus();
      setter.call(element, ${value});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { injected: element.value === ${value} };
    } catch (_) {
      return { injected: false };
    }
  })()`;
}
