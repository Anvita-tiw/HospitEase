import {
  ArrowRight,
  BedDouble,
  Bot,
  Clock,
  GitCompare,
  LayoutDashboard,
  LogIn,
  MessageSquarePlus,
  Search,
  ShieldCheck,
  Stethoscope,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ResilientImage } from '../components/ResilientImage.tsx';
import { EmergencyNotice } from '../components/StatusIndicators.tsx';
import { apiFetch } from '../lib/api.ts';
import type { AppRoute, AuthUser, DashboardSummaryResponse } from '../types.ts';

interface LandingPageProps {
  user: AuthUser | null;
  onNavigate: (route: AppRoute) => void;
  onSearchHospitals: (query: string) => void;
}

export function LandingPage({ user, onNavigate, onSearchHospitals }: LandingPageProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);

  useEffect(() => {
    apiFetch<DashboardSummaryResponse>('/api/dashboard/summary')
      .then((res) => setSummary(res))
      .catch(() => {});
  }, []);

  const handleHeroSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearchHospitals(searchTerm);
  };

  return (
    <div className="min-h-screen bg-[#F5F8FC] text-[#243447]">
      {/* Public SaaS Top Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => onNavigate('landing')}
            className="flex items-center gap-2.5 text-left"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1769AA] text-white shadow-sm">
              <Stethoscope className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <span className="font-display text-lg font-bold tracking-tight text-[#12304A]">
                HospitEase AI
              </span>
              <span className="hidden text-[11px] font-medium text-[#718096] sm:block">
                OPD Queue &amp; Bed Visibility
              </span>
            </div>
          </button>

          <nav className="hidden items-center gap-5 text-sm font-medium text-[#243447] md:flex">
            <button
              type="button"
              onClick={() => onNavigate('hospitals')}
              className="hover:text-[#1769AA]"
            >
              Find Hospitals
            </button>
            <button
              type="button"
              onClick={() => onNavigate('opd-queue')}
              className="hover:text-[#1769AA]"
            >
              OPD Queue
            </button>
            <button
              type="button"
              onClick={() => onNavigate('beds')}
              className="hover:text-[#1769AA]"
            >
              Bed Availability
            </button>
            <button
              type="button"
              onClick={() => onNavigate('compare')}
              className="hover:text-[#1769AA]"
            >
              Compare
            </button>
            <button
              type="button"
              onClick={() => onNavigate('assistant')}
              className="inline-flex items-center gap-1 hover:text-[#1769AA]"
            >
              <Bot className="h-4 w-4 text-[#16A6A1]" />
              <span>AI Assistant</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('ml-info')}
              className="hover:text-[#1769AA]"
            >
              ML &amp; Data
            </button>
          </nav>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => onNavigate('dashboard')}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-[#12304A] hover:bg-slate-50"
            >
              <LayoutDashboard className="h-4 w-4 text-[#1769AA]" />
              <span className="hidden sm:inline">Explore Dashboard</span>
              <span className="sm:hidden">Dashboard</span>
            </button>

            {user ? (
              <button
                type="button"
                onClick={() => onNavigate(user.role === 'admin' ? 'admin' : 'dashboard')}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#1769AA] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
              >
                <span>{user.role === 'admin' ? 'Admin Console' : user.name.split(' ')[0]}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate('auth')}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#1769AA] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
              >
                <LogIn className="h-4 w-4" />
                <span>Sign In</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-14 px-4 py-8 sm:px-6 sm:py-12">
        {/* Hero Section */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-1 items-stretch lg:grid-cols-12">
            <div className="flex flex-col justify-between p-6 sm:p-10 lg:col-span-7">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#16A6A1]">
                    Healthcare SaaS · OPD &amp; Bed Intelligence
                  </span>
                </div>

                <h1
                  className="mt-4 font-display font-bold tracking-tight text-[#12304A]"
                  style={{ fontSize: 'clamp(2.1rem, 3.8vw, 3.25rem)', lineHeight: 1.12, textWrap: 'balance' }}
                >
                  Smarter Hospital Visits Start Here.
                </h1>

                <p className="mt-4 max-w-xl text-base leading-relaxed text-[#718096] sm:text-lg">
                  Find hospitals, check estimated OPD waiting times, and explore bed availability before you
                  visit.
                </p>

                {/* Prominent Search Bar */}
                <form onSubmit={handleHeroSearch} className="mt-7 space-y-3">
                  <div className="flex flex-col gap-2.5 sm:flex-row">
                    <div className="relative flex-1">
                      <label htmlFor="landing-hero-search" className="sr-only">
                        Search by hospital name, location or department
                      </label>
                      <Search
                        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#718096]"
                        aria-hidden="true"
                      />
                      <input
                        id="landing-hero-search"
                        type="search"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Search by hospital name, location or department (e.g. Cardiology, Indore)"
                        className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] pl-10 pr-4 text-sm text-[#243447] placeholder:text-[#718096] focus:border-[#1769AA] focus:bg-white focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#1769AA] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#125388] whitespace-nowrap shrink-0"
                    >
                      <span>Find Hospitals</span>
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => onNavigate('dashboard')}
                      className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-[#12304A]/20 bg-white px-5 py-2 text-sm font-semibold text-[#12304A] transition-colors hover:bg-[#F5F8FC]"
                    >
                      <LayoutDashboard className="h-4 w-4 text-[#1769AA]" />
                      <span>Explore Dashboard</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onNavigate('submit')}
                      className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-[#16A6A1]/35 bg-[#16A6A1]/8 px-4 py-2 text-sm font-semibold text-[#117A76] transition-colors hover:bg-[#16A6A1]/15"
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                      <span>Submit Live Queue Update</span>
                    </button>
                  </div>
                </form>
              </div>

              {/* Quick Department Chips */}
              <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-5">
                <span className="text-xs font-medium text-[#718096]">Popular searches:</span>
                {['General Medicine', 'Cardiology', 'Pediatrics', 'Orthopedics', 'MY Hospital'].map(
                  (chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => onSearchHospitals(chip)}
                      className="rounded-lg border border-slate-200 bg-[#F5F8FC] px-3 py-1.5 text-xs font-medium text-[#243447] transition-colors hover:border-[#1769AA]/40 hover:text-[#1769AA]"
                    >
                      {chip}
                    </button>
                  ),
                )}
              </div>
            </div>

            {/* Right Healthcare Visual Column */}
            <div className="relative min-h-[280px] lg:col-span-5 lg:min-h-[460px]">
              <ResilientImage
                src="/src/assets/images/hero_hospital_atrium_1795182663778.jpg"
                alt="Modern hospital reception atrium with calm patient flow"
                fallbackTitle="HospitEase AI Healthcare Atrium"
                className="h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#12304A]/85 via-[#12304A]/20 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 p-6 text-white">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#5EEAD4]">
                  Transparent Range Estimation
                </p>
                <p className="mt-1 font-display text-base font-semibold leading-snug">
                  Combines historical OPD patterns with recency-weighted patient updates and ward bed tracking.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Hospital Statistics Section */}
        <section aria-label="Platform statistics" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            {
              label: 'Hospitals Available',
              value: summary ? summary.counts.hospitals_available : '—',
              sub: 'Active hospital network',
              color: 'text-[#1769AA]',
            },
            {
              label: 'OPD Departments',
              value: summary ? summary.counts.opd_departments : '—',
              sub: 'Tracked consultation units',
              color: 'text-[#16A6A1]',
            },
            {
              label: 'Validated Queue Updates',
              value: summary ? summary.counts.recent_queue_updates : '—',
              sub: 'Outlier-checked crowd reports',
              color: 'text-[#16A36A]',
            },
            {
              label: 'Hospitals with Bed Info',
              value: summary ? summary.counts.hospitals_with_beds : '—',
              sub: 'Ward-level occupancy tracking',
              color: 'text-[#12304A]',
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition-shadow hover:shadow-sm"
            >
              <div className="text-xs font-medium text-[#718096]">{stat.label}</div>
              <div className={`mt-2 font-mono text-3xl font-bold tabular-nums ${stat.color}`}>
                {stat.value}
              </div>
              <div className="mt-1 text-xs text-[#718096]">{stat.sub}</div>
            </div>
          ))}
        </section>

        {/* Feature Cards Section */}
        <section className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-bold text-[#12304A]">
                Built for Clarity Before Every Hospital Visit
              </h2>
              <p className="mt-1 text-sm text-[#718096]">
                Four focused tools designed for patients, family attendants, and hospital operations.
              </p>
            </div>
            <EmergencyNotice compact />
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: 'OPD Waiting Time Prediction',
                desc: 'View Low, Medium, and High queue levels with calibrated waiting ranges and IST timestamps.',
                icon: Clock,
                accent: 'bg-[#1769AA]/10 text-[#1769AA]',
                route: 'opd-queue' as AppRoute,
                cta: 'Open Queue Gauge',
              },
              {
                title: 'Hospital Bed Availability',
                desc: 'Explore General, ICU, Maternity, and Pediatric ward capacity with 24-hour freshness flags.',
                icon: BedDouble,
                accent: 'bg-[#16A6A1]/12 text-[#117A76]',
                route: 'beds' as AppRoute,
                cta: 'View Ward Beds',
              },
              {
                title: 'Crowdsourced Live Updates',
                desc: 'Contribute structured waiting-time reports protected by outlier checks and 30-min half-life.',
                icon: MessageSquarePlus,
                accent: 'bg-[#16A36A]/10 text-[#117A4F]',
                route: 'submit' as AppRoute,
                cta: 'Submit Update',
              },
              {
                title: 'Hospital Comparison',
                desc: 'Compare 2 to 4 participating hospitals side by side across timings, queue levels, and beds.',
                icon: GitCompare,
                accent: 'bg-[#12304A]/10 text-[#12304A]',
                route: 'compare' as AppRoute,
                cta: 'Compare Hospitals',
              },
            ].map((feat) => {
              const Icon = feat.icon;
              return (
                <div
                  key={feat.title}
                  className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-xs transition-all hover:-translate-y-0.5 hover:border-[#1769AA]/40 hover:shadow-md"
                >
                  <div>
                    <div className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${feat.accent}`}>
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <h3 className="mt-4 font-display text-lg font-semibold text-[#12304A]">
                      {feat.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-[#718096]">{feat.desc}</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onNavigate(feat.route)}
                    className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[#1769AA] hover:text-[#125388]"
                  >
                    <span>{feat.cta}</span>
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Three-Step How It Works Section */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{ duration: 0.25 }}
          className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8"
        >
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-5">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-[#16A6A1]">
                How It Works
              </span>
              <h2 className="mt-1 font-display text-2xl font-bold text-[#12304A]">
                Plan Smarter Hospital Visits in Three Steps
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('ml-info')}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#1769AA] hover:underline"
            >
              <ShieldCheck className="h-4 w-4" />
              <span>See ML &amp; Recency Formula</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Search for a hospital',
                desc: 'Filter participating hospitals by city, hospital type, or OPD department to view current consultation timings.',
                img: '/src/assets/images/patient_home_planning_1795182663490.jpg',
                alt: 'Patient searching hospital OPD schedules from home',
              },
              {
                step: '02',
                title: 'Check queue and bed availability',
                desc: 'Inspect estimated waiting-time ranges, recent validated updates, and ward-wise bed availability percentages.',
                img: '/src/assets/images/hospital_ward_care_1795182664754.jpg',
                alt: 'Modern hospital ward corridor and nursing desk',
              },
              {
                step: '03',
                title: 'Make an informed decision',
                desc: 'Compare up to four hospitals side by side and call the facility directly before leaving home.',
                img: '/src/assets/images/hospital_campus_exterior_1795182663768.jpg',
                alt: 'Modern hospital campus exterior',
              },
            ].map((item) => (
              <div key={item.step} className="overflow-hidden rounded-xl border border-slate-200 bg-[#F5F8FC]">
                <div className="aspect-[4/3] w-full overflow-hidden">
                  <ResilientImage
                    src={item.img}
                    alt={item.alt}
                    fallbackTitle={item.title}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-5">
                  <span className="font-mono text-xs font-bold text-[#1769AA]">STEP {item.step}</span>
                  <h3 className="mt-1 font-display text-lg font-semibold text-[#12304A]">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#718096]">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.section>
      </main>

      {/* Landing Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-4 py-6 text-sm text-[#718096] sm:flex-row sm:items-center sm:px-6">
          <div className="space-y-1">
            <p className="font-display font-semibold text-[#12304A]">
              HospitEase AI — An Intelligent Crowdsourced Platform for OPD Queue &amp; Bed Availability Prediction
            </p>
            <p className="text-xs">
              Disclaimer: Waiting times are estimates and may change depending on hospital conditions. Not for
              medical emergencies — call <span className="font-mono font-semibold text-[#243447]">112</span>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs font-medium shrink-0">
            <button type="button" onClick={() => onNavigate('dashboard')} className="text-[#1769AA] hover:underline">
              Dashboard
            </button>
            <button type="button" onClick={() => onNavigate('hospitals')} className="text-[#1769AA] hover:underline">
              Find Hospitals
            </button>
            <button type="button" onClick={() => onNavigate('compare')} className="text-[#1769AA] hover:underline">
              Compare
            </button>
            <button type="button" onClick={() => onNavigate('ml-info')} className="text-[#1769AA] hover:underline">
              ML &amp; Methodology
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
