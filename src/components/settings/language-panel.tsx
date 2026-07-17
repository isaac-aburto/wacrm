'use client';

import { useState, useTransition } from 'react';
import { Check, Globe2, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { APP_LOCALES, type AppLocale } from '@/i18n/config';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

export function LanguagePanel() {
  const currentLocale = useLocale() as AppLocale;
  const router = useRouter();
  const t = useTranslations('Settings.language');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const selectLocale = (locale: AppLocale) => {
    if (locale === currentLocale || isPending) return;

    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch('/api/locale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
        if (!response.ok) throw new Error('Locale update failed');
        router.refresh();
      } catch {
        setError(t('changeError'));
      }
    });
  };

  return (
    <section className="animate-in fade-in-50 max-w-3xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div
        role="radiogroup"
        aria-label={t('selectorLabel')}
        className="grid max-w-xl gap-3 sm:grid-cols-2"
      >
        {APP_LOCALES.map((locale) => {
          const isActive = locale.id === currentLocale;
          return (
            <button
              key={locale.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={isPending}
              onClick={() => selectLocale(locale.id)}
              className={cn(
                'bg-card flex min-h-24 items-center gap-4 rounded-xl border p-4 text-left transition-colors',
                'disabled:cursor-wait disabled:opacity-70',
                isActive
                  ? 'border-primary/60 ring-primary/40 ring-2'
                  : 'border-border hover:border-primary/40 hover:bg-card-2'
              )}
            >
              <span className="bg-primary-soft text-primary flex size-10 shrink-0 items-center justify-center rounded-full">
                <Globe2 className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-sm font-semibold">
                  {locale.nativeName}
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  {t(`names.${locale.id}`)}
                </span>
              </span>
              {isPending && !isActive ? (
                <Loader2 className="text-primary size-4 animate-spin" />
              ) : isActive ? (
                <span className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                  <Check className="size-3" />
                  {t('active')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
        {t('deviceHint')}
      </p>
      {error ? (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
