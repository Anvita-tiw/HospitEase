import { ResilientImage } from '../components/ResilientImage.tsx';
import { EmergencyNotice } from '../components/StatusIndicators.tsx';

export function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid grid-cols-1 items-stretch md:grid-cols-12">
          <div className="p-6 sm:p-8 md:col-span-7">
            <h1 className="font-display text-2xl font-bold text-slate-900 sm:text-3xl">
              How HospitEase AI Estimates Work
            </h1>
            <p className="mt-3 text-base leading-relaxed text-slate-600">
              HospitEase AI is a patient information tool built around one core observation: historical records show
              the usual daily pattern of an Outpatient Department (OPD), while recent patient reports show what is
              happening right now.
            </p>
          </div>
          <div className="aspect-[4/3] md:col-span-5 md:aspect-auto">
            <ResilientImage
              src="/src/assets/images/patient_home_planning_1795182663490.jpg"
              alt="Patient reviewing hospital queue status from home before visiting"
              fallbackTitle="Patient Planning Guide"
              className="h-full w-full object-cover"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 border-t border-slate-100 p-6 sm:p-8 md:grid-cols-2">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">01. Three Data Sources</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Estimates combine administrator-entered hospital master details (OPD timings and departments), historical
              OPD and bed occupancy records, and timestamped queue reports submitted within the last 2 hours by patients
              who just visited.
            </p>
          </div>

          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              02. Recency Weighting (30-Minute Half-Life)
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Newer patient reports count more than older ones. Each accepted report is weighted by age using{' '}
              <span className="font-mono text-slate-800">w = 0.5^(age / 30 min)</span>. Reports older than 2 hours
              expire from live crowd features, and if none exist, the system falls back to the historical baseline and
              labels it <span className="font-semibold text-slate-800">“Historical data only”</span>.
            </p>
          </div>

          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              03. Ranges Instead of Single Guarantees
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Waiting time is always displayed as an approximate range in minutes (for example{' '}
              <span className="font-mono text-slate-800">25–45 min</span>) derived from held-out validation error and
              rounded to 5 minutes, alongside plain queue levels: <span className="font-semibold">Low</span> (&lt; 20
              min), <span className="font-semibold">Medium</span> (20–45 min), and{' '}
              <span className="font-semibold">High</span> (&gt; 45 min).
            </p>
          </div>

          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              04. Outlier Checks &amp; Moderation
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              To limit careless or inaccurate reports, submissions must match the selected queue level, obey rate
              limits, and pass statistical outlier checks (3×MAD from recent median or 2×SD from historical mean).
              Outliers are flagged for administrator review and excluded until approved.
            </p>
          </div>

          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              05. Bed Availability Categories
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Ward beds are grouped into <span className="font-semibold">Available</span> (≥ 30% free),{' '}
              <span className="font-semibold">Limited Availability</span> (10–30% free), and{' '}
              <span className="font-semibold">Likely Unavailable</span> (&lt; 10% free). Records older than 24 hours
              are visibly marked <span className="font-semibold">Outdated</span>. Always call the hospital to confirm
              beds before travelling.
            </p>
          </div>

          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">06. Privacy &amp; Limitations</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              No patient medical data is collected, update forms contain no free-text fields, and submitter identity is
              never exposed publicly.
            </p>
          </div>
        </div>
      </section>

      <EmergencyNotice />
    </div>
  );
}
