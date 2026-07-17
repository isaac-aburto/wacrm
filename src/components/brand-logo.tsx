import Image from 'next/image';

import { cn } from '@/lib/utils';

export function BrandLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative block shrink-0 overflow-hidden',
        className ?? 'h-8 w-36'
      )}
    >
      <Image
        src="/brand/void-dark.png"
        alt=""
        fill
        sizes="160px"
        className="brand-logo-dark object-cover object-center mix-blend-screen"
      />
      <Image
        src="/brand/void-light.png"
        alt=""
        fill
        sizes="160px"
        className="brand-logo-light object-cover object-center mix-blend-multiply"
      />
      <span className="sr-only">Void</span>
    </span>
  );
}
