function normalizeGroqApiKeys(apiKeys, fallbackKey = '') {
  const merged = [];

  if (Array.isArray(apiKeys)) {
    merged.push(...apiKeys);
  }
  if (typeof fallbackKey === 'string' && fallbackKey.trim()) {
    merged.push(fallbackKey);
  }

  return [...new Set(
    merged
      .map((key) => String(key || '').trim())
      .filter(Boolean)
  )];
}

function pickAvailableGroqKey(apiKeys, cooldowns, cursorState) {
  const normalizedKeys = normalizeGroqApiKeys(apiKeys);
  if (!normalizedKeys.length) {
    return { apiKey: null, index: -1, waitMs: 0, total: 0 };
  }

  const now = Date.now();
  const startIndex = Number(cursorState?.current) || 0;
  let shortestWaitMs = Infinity;

  for (let offset = 0; offset < normalizedKeys.length; offset++) {
    const index = (startIndex + offset) % normalizedKeys.length;
    const apiKey = normalizedKeys[index];
    const cooldownUntil = Number(cooldowns?.get(apiKey) || 0);
    const waitMs = Math.max(0, cooldownUntil - now);

    if (waitMs <= 0) {
      if (cursorState) {
        cursorState.current = (index + 1) % normalizedKeys.length;
      }
      return { apiKey, index, waitMs: 0, total: normalizedKeys.length };
    }

    shortestWaitMs = Math.min(shortestWaitMs, waitMs);
  }

  return {
    apiKey: null,
    index: -1,
    waitMs: Number.isFinite(shortestWaitMs) ? shortestWaitMs : 0,
    total: normalizedKeys.length
  };
}

function setGroqKeyCooldown(cooldowns, apiKey, delayMs) {
  if (!cooldowns || !apiKey || !Number.isFinite(delayMs) || delayMs <= 0) return;
  cooldowns.set(apiKey, Date.now() + delayMs);
}

module.exports = {
  normalizeGroqApiKeys,
  pickAvailableGroqKey,
  setGroqKeyCooldown
};
