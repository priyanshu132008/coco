/** The slice of the Telegram Mini App bridge this app uses. */
interface TelegramWebApp {
  ready(): void
  expand(): void
  close(): void
  HapticFeedback?: {
    notificationOccurred(type: 'error' | 'success' | 'warning'): void
  }
}

interface Telegram {
  WebApp?: TelegramWebApp
}

declare global {
  interface Window {
    Telegram?: Telegram
  }
}

export {}
