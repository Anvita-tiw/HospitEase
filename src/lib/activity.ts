export interface ViewedHospitalEntry {
  hospital_id: number;
  name: string;
  city: string;
  type: string;
  viewedAtIst: string;
}

const SEARCHES_KEY = 'hospitease_recent_searches';
const VIEWED_KEY = 'hospitease_recent_hospitals';

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function recordRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (trimmed.length < 2) return;
  try {
    const prev = getRecentSearches().filter((s) => s.toLowerCase() !== trimmed.toLowerCase());
    localStorage.setItem(SEARCHES_KEY, JSON.stringify([trimmed, ...prev].slice(0, 6)));
  } catch {
    // ignore storage errors
  }
}

export function getRecentlyViewedHospitals(): ViewedHospitalEntry[] {
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function recordViewedHospital(entry: Omit<ViewedHospitalEntry, 'viewedAtIst'>): void {
  try {
    const nowIst = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const prev = getRecentlyViewedHospitals().filter((h) => h.hospital_id !== entry.hospital_id);
    localStorage.setItem(
      VIEWED_KEY,
      JSON.stringify([{ ...entry, viewedAtIst: `${nowIst} IST` }, ...prev].slice(0, 6)),
    );
  } catch {
    // ignore storage errors
  }
}
