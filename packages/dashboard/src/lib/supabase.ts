/** Supabase credentials under either naming convention — the standard Supabase-dashboard
 *  names (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) or the app-era names
 *  (SUPABASE_URL, SUPABASE_SERVICE_KEY). Every reader goes through here. */

export const sbUrl = (): string =>
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''

export const sbKey = (): string =>
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export const sbRemote = (): boolean => Boolean(sbUrl() && sbKey())