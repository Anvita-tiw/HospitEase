import { AlertTriangle, CheckCircle2, Clock, MinusCircle, ShieldAlert } from 'lucide-react';
import type { BedStatus, ConfidenceLevel, QueueLevel } from '../types.ts';

export function QueueLevelBadge({ level }: { level: QueueLevel }) {
  if (level === 'Low') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-[#16A36A]/30 bg-[#16A36A]/10 px-2.5 py-1 text-xs font-semibold text-[#117A4F] whitespace-nowrap">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#16A36A]" aria-hidden="true" />
        <span>Low Queue</span>
      </span>
    );
  }
  if (level === 'Medium') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-2.5 py-1 text-xs font-semibold text-[#A16207] whitespace-nowrap">
        <Clock className="h-3.5 w-3.5 shrink-0 text-[#D97706]" aria-hidden="true" />
        <span>Medium Queue</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[#E05252]/35 bg-[#E05252]/10 px-2.5 py-1 text-xs font-semibold text-[#B91C1C] whitespace-nowrap">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#E05252]" aria-hidden="true" />
      <span>High Queue</span>
    </span>
  );
}

export function BedStatusIndicator({ status }: { status: BedStatus }) {
  if (status === 'Available') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-[#16A36A]/30 bg-[#16A36A]/10 px-2.5 py-1 text-xs font-semibold text-[#117A4F] whitespace-nowrap">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#16A36A]" aria-hidden="true" />
        <span>Available</span>
      </span>
    );
  }
  if (status === 'Limited Availability') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-2.5 py-1 text-xs font-semibold text-[#A16207] whitespace-nowrap">
        <MinusCircle className="h-3.5 w-3.5 shrink-0 text-[#D97706]" aria-hidden="true" />
        <span>Limited Availability</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[#E05252]/35 bg-[#E05252]/10 px-2.5 py-1 text-xs font-semibold text-[#B91C1C] whitespace-nowrap">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#E05252]" aria-hidden="true" />
      <span>Likely Unavailable</span>
    </span>
  );
}

export function ConfidenceText({ confidence }: { confidence: ConfidenceLevel }) {
  const tone =
    confidence === 'High'
      ? 'text-[#16A36A] font-semibold'
      : confidence === 'Medium'
        ? 'text-[#D97706] font-semibold'
        : 'text-[#718096] font-semibold';
  return <span className={tone}>{confidence} confidence</span>;
}

export function EmergencyNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="note"
      aria-label="Non-emergency notice"
      className={`flex items-start gap-2.5 rounded-xl border border-[#F59E0B]/35 bg-[#FEF3C7]/45 text-[#78350F] ${
        compact ? 'px-3.5 py-2.5 text-sm' : 'px-4 py-3 text-sm'
      }`}
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" aria-hidden="true" />
      <p className="leading-snug">
        <span className="font-semibold">Not for emergencies.</span> For urgent medical care, contact the
        hospital directly or call <span className="font-mono font-semibold tabular-nums">112</span> (India).
      </p>
    </div>
  );
}
