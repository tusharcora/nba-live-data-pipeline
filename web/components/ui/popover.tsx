"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

// `modal="trap-focus"`: focus is trapped inside the popup while open (Tab
// can't leak to the page behind it), but page scroll and outside pointer
// interaction stay enabled -- unlike a full modal, this fits a "quick
// glance" card that shouldn't feel like a page-blocking dialog. Requires a
// `Popover.Close` inside `Popover.Popup` (rendered below) so touch screen
// readers can still escape it. Default `open`/`onOpenChange` are left
// uncontrolled -- every consumer here is a simple click-to-open card, not a
// controlled popover.
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" modal="trap-focus" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverPortal({ ...props }: PopoverPrimitive.Portal.Props) {
  return <PopoverPrimitive.Portal data-slot="popover-portal" {...props} />
}

function PopoverPositioner({
  sideOffset = 8,
  ...props
}: PopoverPrimitive.Positioner.Props) {
  return (
    <PopoverPrimitive.Positioner
      data-slot="popover-positioner"
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: PopoverPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <PopoverPortal>
      <PopoverPositioner>
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          // No open/close CSS animation classes here (unlike dialog.tsx's
          // DialogContent, which this was modeled on) -- Base UI's
          // animation-completion detection for Popover's Portal/Positioner/
          // Popup structure didn't unmount the popup after its exit
          // animation genuinely finished (confirmed via
          // getComputedStyle: a real 0.15s "exit" animation ran, but the
          // element never left the DOM afterward -- Escape and the Close
          // button both became permanently inert). Dropping the animation
          // avoids depending on that completion detection at all, so close
          // actually works; revisit if this Base UI version fixes the
          // underlying integration gap.
          className={cn(
            "relative z-50 w-72 rounded-xl bg-popover p-3 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none",
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <PopoverPrimitive.Close
              data-slot="popover-close"
              render={
                <Button
                  variant="ghost"
                  className="absolute top-2 right-2"
                  size="icon-sm"
                />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </PopoverPrimitive.Close>
          )}
        </PopoverPrimitive.Popup>
      </PopoverPositioner>
    </PopoverPortal>
  )
}

export { Popover, PopoverContent, PopoverPortal, PopoverPositioner, PopoverTrigger }
