import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/utils';

const ToggleGroupContext = React.createContext<{ size?: 'default' | 'sm' }>({ size: 'default' });

function ToggleGroup({ className, size = 'default', children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { size?: 'default' | 'sm' }) {
    return (
        <ToggleGroupPrimitive.Root
            data-slot="toggle-group"
            className={cn('flex items-center gap-1', className)}
            {...props}
        >
            <ToggleGroupContext.Provider value={{ size }}>{children}</ToggleGroupContext.Provider>
        </ToggleGroupPrimitive.Root>
    );
}

function ToggleGroupItem({ className, size: sizeProp, children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & { size?: 'default' | 'sm' }) {
    const { size: ctxSize } = React.useContext(ToggleGroupContext);
    const size = sizeProp ?? ctxSize;
    return (
        <ToggleGroupPrimitive.Item
            data-slot="toggle-group-item"
            className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-full font-normal text-muted-foreground ' +
                'transition-colors hover:bg-bubble hover:text-foreground ' +
                'data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:font-medium ' +
                'outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45',
                size === 'sm' ? 'h-7 px-3 text-[13px]' : 'h-8 px-3.5 text-sm',
                className,
            )}
            {...props}
        >
            {children}
        </ToggleGroupPrimitive.Item>
    );
}

export { ToggleGroup, ToggleGroupItem };
