import html2canvas from 'html2canvas'

/**
 * Capture a screenshot + gather context and send bug report to server.
 * Server forwards to Telegram. Works even from ErrorBoundary (no React context needed).
 */
export async function sendBugReport(description: string, error?: Error): Promise<void> {
  // 1. Screenshot
  let screenshotBase64: string | null = null
  const isDesktop = !!(window as any).restosDesktop?.isDesktop

  // Hide fixed overlays (dialogs, modals) so they don't appear in the screenshot
  const overlays = document.querySelectorAll<HTMLElement>('[class*="fixed"][class*="z-"]')
  overlays.forEach((el) => el.style.visibility = 'hidden')

  // Wait for repaint so the hidden state is visible before capture
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  // Extra delay for Electron's capturePage to reflect the change
  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  if (isDesktop && (window as any).restosDesktop?.captureScreenshot) {
    // Desktop: use native Electron capturePage (no oklch issues)
    try {
      screenshotBase64 = await (window as any).restosDesktop.captureScreenshot()
    } catch {
      // silent
    }
  } else {
    // Web: use html2canvas
    try {
      const canvas = await html2canvas(document.body, {
        scale: 0.3,
        logging: false,
        useCORS: true,
        allowTaint: true,
      })
      screenshotBase64 = canvas.toDataURL('image/jpeg', 0.5)
    } catch {
      // silent
    }
  }

  // Restore overlays
  overlays.forEach((el) => el.style.visibility = '')

  // 2. Gather context (read from localStorage since we may not have React context)
  let userName = 'unknown'
  let restaurantName = 'unknown'
  try {
    const stored = localStorage.getItem('restos-auth-user')
    if (stored) {
      const u = JSON.parse(stored)
      userName = u.name || u.username || 'unknown'
    }
    const storedRest = localStorage.getItem('restos-restaurant')
    if (storedRest) {
      const r = JSON.parse(storedRest)
      restaurantName = r.name || r.id || 'unknown'
    }
  } catch {
    // ignore
  }

  const context = {
    user: userName,
    restaurant: restaurantName,
    url: window.location.pathname,
    device: navigator.userAgent,
    platform: (window as any).restosDesktop?.isDesktop ? 'desktop' : 'web',
    version: (window as any).restosDesktop?.version || 'unknown',
    error: error?.message || '',
    stack: error?.stack?.slice(0, 800) || '',
    timestamp: new Date().toISOString(),
  }

  // 3. Send as JSON (base64 screenshot) — limit to ~1MB to avoid Vercel body limit
  if (screenshotBase64 && screenshotBase64.length > 1_000_000) {
    import('@sentry/react').then(Sentry => Sentry.captureMessage(`Screenshot too large: ${screenshotBase64!.length} bytes, skipping`, 'warning'))
    screenshotBase64 = null
  }

  const baseUrl = (window as any).restosDesktop?.isDesktop ? 'https://v0-restos.vercel.app' : ''
  const res = await fetch(`${baseUrl}/api/bug-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description,
      context,
      screenshot: screenshotBase64,
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown')
    console.error('[bug-report] API error:', res.status, errText)
    throw new Error(`Bug report failed: ${res.status}`)
  }
}
