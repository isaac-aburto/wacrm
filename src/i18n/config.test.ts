import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, isAppLocale } from './config';

describe('i18n config', () => {
  it('uses Spanish by default', () => {
    expect(DEFAULT_LOCALE).toBe('es');
  });

  it('only accepts supported locale identifiers', () => {
    expect(isAppLocale('es')).toBe(true);
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('fr')).toBe(false);
    expect(isAppLocale('../messages/en')).toBe(false);
    expect(isAppLocale(null)).toBe(false);
  });
});
