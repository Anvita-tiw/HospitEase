import type { OpdTimingsConfig } from '../types.ts';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// National + Madhya Pradesh holidays for 2026 (TBD-12)
const HOLIDAYS_IST = new Set<string>([
  '2026-01-26', // Republic Day
  '2026-03-04', // Holi
  '2026-03-21', // Id-ul-Fitr (approx)
  '2026-03-27', // Ram Navami
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-08-15', // Independence Day
  '2026-08-28', // Raksha Bandhan
  '2026-09-04', // Janmashtami
  '2026-10-02', // Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-01', // Madhya Pradesh Foundation Day
  '2026-11-08', // Diwali
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas Day
]);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface IstParts {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number; // 0=Sun..6=Sat
  hour: number;
  minute: number;
  totalMinutes: number;
  timeSlot: 'morning' | 'midday' | 'afternoon' | 'evening' | 'off_hours';
  dateStr: string;
  isWeekend: boolean;
  isHoliday: boolean;
  formattedIST: string;
}

export function getTimeSlot(hour: number): IstParts['timeSlot'] {
  if (hour >= 8 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'off_hours';
}

export function toISTParts(utcDateInput: Date | string): IstParts {
  const date = typeof utcDateInput === 'string' ? new Date(utcDateInput) : utcDateInput;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);

  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const day = ist.getUTCDate();
  const dayOfWeek = ist.getUTCDay();
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;

  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const isWeekend = dayOfWeek === 0; // Sunday is standard hospital OPD weekend in India; Sat is working
  const isHoliday = HOLIDAYS_IST.has(dateStr);

  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const formattedIST = `${pad(day)}/${pad(month)}/${year}, ${hour12}:${pad(minute)} ${ampm} IST`;

  return {
    year,
    month,
    day,
    dayOfWeek,
    hour,
    minute,
    totalMinutes,
    timeSlot: getTimeSlot(hour),
    dateStr,
    isWeekend,
    isHoliday,
    formattedIST,
  };
}

export function formatUtcAsIST(utcIso: string | null | undefined): string {
  if (!utcIso) return 'Not available';
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return 'Not available';
  return toISTParts(d).formattedIST;
}

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatHHMM12(hhmm: string): string {
  const [hRaw, mRaw] = hhmm.split(':').map(Number);
  const h = hRaw || 0;
  const m = mRaw || 0;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export interface OpdStatusResult {
  isOpenNow: boolean;
  label: string;
  currentSessionText: string | null;
  nextOpeningText: string | null;
}

export function evaluateOpdStatus(opdTimingsJson: string, nowUtc: Date = new Date()): OpdStatusResult {
  let config: OpdTimingsConfig;
  try {
    config = JSON.parse(opdTimingsJson) as OpdTimingsConfig;
  } catch {
    return {
      isOpenNow: true,
      label: opdTimingsJson || '09:00 AM - 05:00 PM',
      currentSessionText: null,
      nextOpeningText: null,
    };
  }

  const nowIst = toISTParts(nowUtc);
  const sessions = config.sessions || [];

  // Check if currently inside any active session today
  for (const session of sessions) {
    if (!session.days.includes(nowIst.dayOfWeek)) continue;
    const startMin = parseHHMM(session.start);
    const endMin = parseHHMM(session.end);
    if (nowIst.totalMinutes >= startMin && nowIst.totalMinutes < endMin) {
      return {
        isOpenNow: true,
        label: config.label,
        currentSessionText: `Open until ${formatHHMM12(session.end)} IST`,
        nextOpeningText: null,
      };
    }
  }

  // Find next opening time across the next 7 days
  for (let offset = 0; offset < 7; offset++) {
    const candidateDay = (nowIst.dayOfWeek + offset) % 7;
    const daySessions = sessions
      .filter((s) => s.days.includes(candidateDay))
      .sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));

    for (const s of daySessions) {
      const startMin = parseHHMM(s.start);
      if (offset === 0 && startMin <= nowIst.totalMinutes) {
        continue;
      }
      const dayLabel = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : DAY_NAMES[candidateDay];
      return {
        isOpenNow: false,
        label: config.label,
        currentSessionText: null,
        nextOpeningText: `${dayLabel} at ${formatHHMM12(s.start)} IST`,
      };
    }
  }

  return {
    isOpenNow: false,
    label: config.label,
    currentSessionText: null,
    nextOpeningText: 'Check hospital schedule',
  };
}
