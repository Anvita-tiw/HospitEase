import { CheckCircle2, Cpu, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmergencyNotice } from '../components/StatusIndicators.tsx';
import { apiFetch } from '../lib/api.ts';
import type { ModelVersionRecord } from '../types.ts';

export function MlInfoPage() {
  const [activeModel, setActiveModel] = useState<ModelVersionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportAgeMin, setReportAgeMin] = useState<number>(30);

  useEffect(() => {
    apiFetch<{ active_model: ModelVersionRecord | null }>('/api/ml/overview')
      .then((res) => setActiveModel(res.active_model))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const halfLife = 30;
  const computedWeight = Math.pow(0.5, reportAgeMin / halfLife);

  const steps = [
    {
      num: '01',
      title: 'Historical Data Collection',
      desc: 'Gather hospital OPD queue logs, waiting-time records, bed snapshots, and validated crowd updates.',
    },
    {
      num: '02',
      title: 'Data Preprocessing',
      desc: 'Filter out Flagged/Rejected reports, normalize IST timestamps, and align 30-min/1-hour intervals.',
    },
    {
      num: '03',
      title: 'Feature Extraction',
      desc: 'Build temporal, holiday, hospital/department, lagged wait, and recency-weighted crowd features.',
    },
    {
      num: '04',
      title: 'Model Training',
      desc: 'Train Ridge Linear Regression, Random Forest, and Gradient Boosting on an 80% chronological split.',
    },
    {
      num: '05',
      title: 'Model Evaluation',
      desc: 'Compare MAE, RMSE, and R² against the Historical Average Baseline on the held-out 20% test split.',
    },
    {
      num: '06',
      title: 'Waiting-Time Prediction',
      desc: 'Deploy the winning ML model only if both MAE & RMSE beat baseline, outputting calibrated ranges.',
    },
  ];

  const candidates = activeModel?.metrics.candidates || [];
  const maxErr = candidates.length > 0 ? Math.max(...candidates.map((c) => Math.max(c.mae, c.rmse)), 8) : 8;

  return (
    <div className="space-y-6">
      {/* Intro Header */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <Cpu className="h-6 w-6 text-[#1769AA]" aria-hidden="true" />
          <h1 className="font-display text-2xl font-bold text-[#12304A]">
            Machine Learning Pipeline &amp; Methodology
          </h1>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#718096]">
          HospitEase AI evaluates multiple supervised regression models against a transparent Historical Average
          Baseline on chronological held-out data. An ML model is deployed only when both{' '}
          <strong className="text-[#12304A]">MAE</strong> and <strong className="text-[#12304A]">RMSE</strong>{' '}
          strictly beat the baseline.
        </p>
      </section>

      {/* 6-Step ML Workflow */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="font-display text-lg font-semibold text-[#12304A]">
          6-Step Prediction &amp; Evaluation Workflow
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s) => (
            <div key={s.num} className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4">
              <span className="font-mono text-xs font-bold text-[#1769AA]">STEP {s.num}</span>
              <h3 className="mt-1 font-display text-base font-semibold text-[#12304A]">{s.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-[#718096]">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Algorithm Comparison Chart & Table */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Algorithm Comparison: MAE &amp; RMSE vs Baseline
            </h2>
            <p className="text-xs text-[#718096]">
              {activeModel
                ? `Active version ${activeModel.model_version} (${activeModel.model_type}) · ${activeModel.metrics.train_samples} train / ${activeModel.metrics.test_samples} test samples`
                : '80/20 chronological split evaluation'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#16A36A]/30 bg-[#16A36A]/10 px-3 py-1.5 text-xs font-semibold text-[#117A4F]">
            <CheckCircle2 className="h-4 w-4 text-[#16A36A]" />
            <span>Deployed only when beating baseline</span>
          </span>
        </div>

        {/* Visual Bar Chart */}
        {loading ? (
          <div className="mt-5 h-48 animate-pulse rounded-xl bg-slate-100" />
        ) : candidates.length === 0 ? (
          <div className="mt-5 rounded-xl border border-slate-200 bg-[#F5F8FC] p-6 text-center text-sm text-[#718096]">
            No trained model evaluation metrics are available yet.
          </div>
        ) : (
        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-6">
            {candidates.map((c) => {
              const maeWidth = Math.round((c.mae / maxErr) * 100);
              const rmseWidth = Math.round((c.rmse / maxErr) * 100);
              return (
                <div
                  key={c.model_name}
                  className={`rounded-xl border p-3.5 ${
                    c.is_selected ? 'border-[#1769AA] bg-[#1769AA]/5' : 'border-slate-100 bg-[#F5F8FC]'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-semibold text-[#12304A]">
                    <span>{c.model_name}</span>
                    {c.is_selected && <span className="text-[#16A36A]">Active Model</span>}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-12 font-mono text-[#718096]">MAE</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-[#1769AA]" style={{ width: `${maeWidth}%` }} />
                      </div>
                      <span className="w-16 text-right font-mono font-semibold text-[#12304A] tabular-nums">
                        {c.mae.toFixed(2)}m
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-12 font-mono text-[#718096]">RMSE</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-[#16A6A1]" style={{ width: `${rmseWidth}%` }} />
                      </div>
                      <span className="w-16 text-right font-mono font-semibold text-[#12304A] tabular-nums">
                        {c.rmse.toFixed(2)}m
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Detailed Metrics Table */}
          <div className="overflow-x-auto lg:col-span-6">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold text-[#718096]">
                  <th className="py-2.5 pr-3">Model</th>
                  <th className="px-3 py-2.5 text-right">MAE (min)</th>
                  <th className="px-3 py-2.5 text-right">RMSE (min)</th>
                  <th className="px-3 py-2.5 text-right">R²</th>
                  <th className="pl-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {candidates.map((c) => (
                  <tr key={c.model_name} className={c.is_selected ? 'bg-[#1769AA]/6' : ''}>
                    <td className="py-3 pr-3 font-medium text-[#12304A]">{c.model_name}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{c.mae.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{c.rmse.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{c.r2.toFixed(3)}</td>
                    <td className="pl-3 py-3 text-xs font-semibold">
                      {c.is_selected ? (
                        <span className="text-[#16A36A]">Selected</span>
                      ) : (
                        <span className="text-[#718096]">Evaluated</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {activeModel?.metrics.bed_classifier && (
              <div className="mt-5 rounded-xl border border-slate-200 bg-[#F5F8FC] p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#12304A]">
                  <ShieldCheck className="h-4 w-4 text-[#16A6A1]" />
                  <span>Bed Availability Classifier Performance</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center font-mono text-xs">
                  <div className="rounded-lg bg-white p-2.5">
                    <div className="font-sans text-[#718096]">Accuracy</div>
                    <div className="mt-0.5 text-base font-bold text-[#12304A]">
                      {(activeModel.metrics.bed_classifier.accuracy * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="rounded-lg bg-white p-2.5">
                    <div className="font-sans text-[#718096]">Precision</div>
                    <div className="mt-0.5 text-base font-bold text-[#12304A]">
                      {(activeModel.metrics.bed_classifier.macro_precision * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="rounded-lg bg-white p-2.5">
                    <div className="font-sans text-[#718096]">Recall</div>
                    <div className="mt-0.5 text-base font-bold text-[#12304A]">
                      {(activeModel.metrics.bed_classifier.macro_recall * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        )}
      </section>

      {/* Exponential Recency Decay Formula Explorer */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-3 lg:col-span-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Exponential Recency Weighting Formula
            </h2>
            <p className="text-sm leading-relaxed text-[#718096]">
              Crowdsourced reports within the last 2 hours are weighted by age so fresh hospital observations carry
              more influence than older ones:
            </p>
            <div className="rounded-xl border border-[#1769AA]/25 bg-[#F5F8FC] p-4 font-mono text-base font-bold text-[#12304A]">
              w = 0.5^(age / h) &nbsp;&nbsp;where h = 30 minutes
            </div>
            <div className="pt-2">
              <div className="flex items-center justify-between text-xs font-semibold text-[#12304A]">
                <label htmlFor="decay-age-slider">Report Age: {reportAgeMin} minutes</label>
                <span className="font-mono text-[#1769AA] tabular-nums">
                  Weight w = {computedWeight.toFixed(3)} ({Math.round(computedWeight * 100)}%)
                </span>
              </div>
              <input
                id="decay-age-slider"
                type="range"
                min={0}
                max={120}
                step={5}
                value={reportAgeMin}
                onChange={(e) => setReportAgeMin(Number(e.target.value))}
                className="mt-2 w-full accent-[#1769AA]"
              />
              <div className="flex justify-between text-[11px] text-[#718096] font-mono">
                <span>0m (1.00)</span>
                <span>30m (0.50)</span>
                <span>60m (0.25)</span>
                <span>90m (0.125)</span>
                <span>120m (Expires)</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-[#F5F8FC] p-4 lg:col-span-6">
            <svg viewBox="0 0 360 160" className="w-full max-w-md">
              <line x1="36" y1="130" x2="340" y2="130" stroke="#CBD5E1" strokeWidth="1.5" />
              <line x1="36" y1="20" x2="36" y2="130" stroke="#CBD5E1" strokeWidth="1.5" />
              {/* Exponential curve path */}
              <path
                d={Array.from({ length: 25 }, (_, i) => {
                  const age = i * 5;
                  const w = Math.pow(0.5, age / 30);
                  const x = 36 + (age / 120) * 300;
                  const y = 130 - w * 105;
                  return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                }).join(' ')}
                fill="none"
                stroke="#1769AA"
                strokeWidth="3"
                strokeLinecap="round"
              />
              {/* Active marker */}
              <circle
                cx={36 + (reportAgeMin / 120) * 300}
                cy={130 - computedWeight * 105}
                r="6"
                fill="#16A6A1"
                stroke="#FFFFFF"
                strokeWidth="2"
              />
              <text x="36" y="146" fontSize="10" fill="#718096">
                0 min
              </text>
              <text x="108" y="146" fontSize="10" fill="#718096">
                30 min (h)
              </text>
              <text x="296" y="146" fontSize="10" fill="#718096">
                120 min
              </text>
              <text x="8" y="26" fontSize="10" fill="#718096">
                1.0
              </text>
              <text x="8" y="78" fontSize="10" fill="#718096">
                0.5
              </text>
            </svg>
          </div>
        </div>
      </section>

      <EmergencyNotice compact />
    </div>
  );
}
