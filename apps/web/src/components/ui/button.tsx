import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/* Button — shadcn new-york 骨架,语义槽指到 tokens.css:
   default = 琥珀点睛(发送/极少主操作),其余一律中性灰。 */
const buttonVariants = cva(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium ' +
    'outline-none transition-colors cursor-pointer select-none ' +
    'focus-visible:ring-2 focus-visible:ring-ring/40 ' +
    'disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
                secondary: 'bg-secondary text-secondary-foreground hover:bg-sel hover:text-foreground',
                outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
                ghost: 'text-ink-2 hover:bg-accent hover:text-accent-foreground',
                destructive: 'bg-destructive/15 text-destructive hover:bg-destructive/25',
                link: 'text-primary underline-offset-4 hover:underline',
            },
            size: {
                default: 'h-9 px-3.5',
                sm: 'h-8 px-3 text-[13px]',
                icon: 'size-[30px] rounded-sm',
                'icon-sm': 'size-[28px] rounded-sm',
            },
        },
        defaultVariants: { variant: 'default', size: 'default' },
    },
);

function Button({
    className,
    variant,
    size,
    asChild = false,
    ...props
}: React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot : 'button';
    return (
        <Comp
            data-slot="button"
            className={cn(buttonVariants({ variant, size, className }))}
            {...props}
        />
    );
}

export { Button, buttonVariants };
