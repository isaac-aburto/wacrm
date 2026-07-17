import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isAppLocale,
} from '@/i18n/config';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const locale =
    typeof body === 'object' && body !== null && 'locale' in body
      ? (body as { locale?: unknown }).locale
      : null;

  if (!isAppLocale(locale)) {
    return NextResponse.json({ error: 'Unsupported locale' }, { status: 400 });
  }

  (await cookies()).set(LOCALE_COOKIE, locale, {
    httpOnly: true,
    sameSite: 'lax',
    secure:
      request.nextUrl.protocol === 'https:' ||
      request.headers.get('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
  });

  return NextResponse.json({ locale });
}
