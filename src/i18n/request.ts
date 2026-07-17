import { getRequestConfig } from 'next-intl/server';
import type { AbstractIntlMessages } from 'next-intl';
import { cookies } from 'next/headers';

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isAppLocale,
  type AppLocale,
} from './config';

const messageLoaders: Record<
  AppLocale,
  () => Promise<{ default: AbstractIntlMessages }>
> = {
  es: () => import('../../messages/es.json'),
  en: () => import('../../messages/en.json'),
};

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isAppLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;
  const messages = (await messageLoaders[locale]()).default;

  return {
    locale,
    messages,
  };
});
