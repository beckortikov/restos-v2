'use client'

import * as React from 'react'
import { Drawer as DrawerPrimitive } from 'vaul'
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Adaptive sheet: bottom sheet with swipe-to-close on mobile (vaul),
 * side sheet (right) on desktop (@radix-ui/react-dialog).
 * Breakpoint: md (768px).
 */

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  )
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    setIsMobile(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

// ── Root ────────────────────────────────────────────────────────────────────
interface SheetProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

function BottomSheet({ open, onOpenChange, children }: SheetProps) {
  const isMobile = useIsMobile()
  return isMobile ? (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      {children}
    </DrawerPrimitive.Root>
  ) : (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </SheetPrimitive.Root>
  )
}

// ── Content ─────────────────────────────────────────────────────────────────
function BottomSheetContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mt-24 flex h-auto max-h-[92vh] flex-col rounded-t-2xl border border-border bg-background',
            className,
          )}
          {...(props as any)}
        >
          <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          {children}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    )
  }

  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <SheetPrimitive.Content
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-full border-l sm:max-w-md',
          className,
        )}
        {...(props as any)}
      >
        {children}
        <SheetPrimitive.Close className="ring-offset-background focus:ring-ring absolute top-4 right-4 size-10 flex items-center justify-center rounded-xl bg-muted/50 opacity-70 transition-opacity hover:opacity-100 active:bg-muted focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
          <XIcon className="size-5" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

// ── Header / Footer ─────────────────────────────────────────────────────────
function BottomSheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('grid gap-1.5 p-4 md:p-5', className)} {...props} />
}

function BottomSheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('mt-auto flex flex-col gap-2 p-4 md:p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] md:pb-5', className)}
      {...props}
    />
  )
}

// ── Title / Description ─────────────────────────────────────────────────────
function BottomSheetTitle({ className, children, ...props }: React.ComponentProps<'h2'>) {
  const isMobile = useIsMobile()
  const Primitive: any = isMobile ? DrawerPrimitive.Title : SheetPrimitive.Title
  return (
    <Primitive className={cn('text-lg font-semibold text-foreground', className)} {...props}>
      {children}
    </Primitive>
  )
}

function BottomSheetDescription({ className, children, ...props }: React.ComponentProps<'p'>) {
  const isMobile = useIsMobile()
  const Primitive: any = isMobile ? DrawerPrimitive.Description : SheetPrimitive.Description
  return (
    <Primitive className={cn('text-sm text-muted-foreground', className)} {...props}>
      {children}
    </Primitive>
  )
}

// ── Close / Trigger ─────────────────────────────────────────────────────────
function BottomSheetClose(props: any) {
  const isMobile = useIsMobile()
  const Primitive: any = isMobile ? DrawerPrimitive.Close : SheetPrimitive.Close
  return <Primitive {...props} />
}

function BottomSheetTrigger(props: any) {
  const isMobile = useIsMobile()
  const Primitive: any = isMobile ? DrawerPrimitive.Trigger : SheetPrimitive.Trigger
  return <Primitive {...props} />
}

export {
  BottomSheet,
  BottomSheetTrigger,
  BottomSheetClose,
  BottomSheetContent,
  BottomSheetHeader,
  BottomSheetFooter,
  BottomSheetTitle,
  BottomSheetDescription,
}
