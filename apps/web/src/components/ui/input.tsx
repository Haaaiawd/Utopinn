import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn(
                'flex h-9 w-full min-w-0 rounded-md border border-border bg-transparent px-3 text-sm text-foreground ' +
                'placeholder:text-muted-foreground outline-none transition-[border-color,box-shadow] ' +
                'focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25 ' +
                'disabled:cursor-not-allowed disabled:opacity-50',
                className,
            )}
            {...props}
        />
    );
}

export { Input };
