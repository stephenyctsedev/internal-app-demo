/** Auto refresh: how often the open page re-reads the Google Sheet.
 *  TanStack Query pauses the interval while the tab / app is in the
 *  background, and refetchOnWindowFocus re-reads straight away when the
 *  user comes back. Kept at 60 s because the web version reads through one
 *  service account (Sheets quota: 60 reads / minute, shared by everyone). */
export const AUTO_REFRESH_MS = 60_000;
