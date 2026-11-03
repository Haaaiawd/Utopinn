import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/* Badge — .chip 的继任者:中性灰底为默认,语义色只走 warning/destructive。 */
const badgeVariants = cva(
    'inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-[3px] text-xs ' +
    'font-normal leading-none transition-colors [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                secondary: 'bg-bubble text-ink-2',
                default: 'bg-primary/15 text-amber',
                warning: 'bg-[#e8a13c1f] text-warning',
                destructive: 'bg-destructive/15 text-destructive',
                outline: 'border-border text-ink-2',
            },
        },
        defaultVariants: { variant: 'secondary' },
    },
);

function Badge({
    className,
    variant,
    ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
    return (
        <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
    );
}

export { Badge, badgeVariants };
