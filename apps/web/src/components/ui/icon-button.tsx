import * as React from 'react';
import { Button } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { cn } from '@/lib/utils';

/* IconButton — app 级复合:ghost 图标按钮 + Tooltip 一体。
   收编原 .ibtn 的全部场景;danger 走 className="hover:text-destructive"。 */
export function IconButton({
    label,
    icon,
    size = 'icon',
    className,
    tooltipSide,
    ...props
}: React.ComponentProps<typeof Button> & {
    label: string;
    icon: React.ReactNode;
    tooltipSide?: React.ComponentProps<typeof TooltipContent>['side'];
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size={size}
                    aria-label={label}
                    className={cn(className)}
                    {...props}
                >
                    {icon}
                </Button>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide}>{label}</TooltipContent>
        </Tooltip>
    );
}
