export const LOCALES = ['es', 'en'] as const;

export type AppLocale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'es';
export const LOCALE_COOKIE = 'wacrm.locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface LocaleMeta {
  id: AppLocale;
  name: string;
  nativeName: string;
}

export const APP_LOCALES: readonly LocaleMeta[] = [
  { id: 'es', name: 'Spanish', nativeName: 'Español' },
  { id: 'en', name: 'English', nativeName: 'English' },
];

export function isAppLocale(value: unknown): value is AppLocale {
  return (
    typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
  );
}
