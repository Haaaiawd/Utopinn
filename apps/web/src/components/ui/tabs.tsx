import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

/* Tabs — Radix 分段控件。容器 = 中性灰 pill(--bg2),选中块浮到 --raised,
   不蹭琥珀色。ctbar vtabs / 右栏 sp-tabs / 设置 seg 共用这一副骨架。 */

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
    return <TabsPrimitive.Root data-slot="tabs" className={cn(className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
    return (
        <TabsPrimitive.List
            data-slot="tabs-list"
            className={cn(
                'inline-flex items-center gap-0.5 rounded-md bg-surface p-[3px]',
                className,
            )}
            {...props}
        />
    );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
    return (
        <TabsPrimitive.Trigger
            data-slot="tabs-trigger"
            className={cn(
                'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3.5 py-1.5 text-sm ' +
                'text-ink-2 outline-none transition-colors cursor-pointer select-none ' +
                'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 ' +
                'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:font-semibold ' +
                'data-[state=active]:shadow-sm disabled:pointer-events-none disabled:opacity-50',
                className,
            )}
            {...props}
        />
    );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
    return (
        <TabsPrimitive.Content
            data-slot="tabs-content"
            className={cn('outline-none', className)}
            {...props}
        />
    );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
