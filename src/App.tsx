import { useCallback, useEffect, useState } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { FirebaseProvider, useFirebase } from './contexts/FirebaseContext.tsx';
import { clearStoredSession, getStoredToken, getStoredUser, setStoredSession } from './lib/api.ts';
import { AdminConsolePage } from './pages/AdminConsolePage.tsx';
import { AssistantPage } from './pages/AssistantPage.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { BedAvailabilityPage } from './pages/BedAvailabilityPage.tsx';
import { ComparePage } from './pages/ComparePage.tsx';
import { HomeSearchPage } from './pages/HomeSearchPage.tsx';
import { HospitalDetailPage } from './pages/HospitalDetailPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { MlInfoPage } from './pages/MlInfoPage.tsx';
import { OpdQueuePage } from './pages/OpdQueuePage.tsx';
import { SubmitUpdatePage } from './pages/SubmitUpdatePage.tsx';
import { UserDashboardPage } from './pages/UserDashboardPage.tsx';
import type { AdminSection, AppRoute, AuthUser } from './types.ts';

interface AppViewProps {
  route: AppRoute;
  setRoute: React.Dispatch<React.SetStateAction<AppRoute>>;
  adminSection: AdminSection;
  setAdminSection: React.Dispatch<React.SetStateAction<AdminSection>>;
  globalSearchQuery: string;
  setGlobalSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  selectedHospitalId: number | null;
  setSelectedHospitalId: React.Dispatch<React.SetStateAction<number | null>>;
  compareIds: number[];
  setCompareIds: React.Dispatch<React.SetStateAction<number[]>>;
  prefillReport: { hospitalId: number | null; departmentId: number | null };
  setPrefillReport: React.Dispatch<
    React.SetStateAction<{ hospitalId: number | null; departmentId: number | null }>
  >;
  user: AuthUser | null;
  setUser: React.Dispatch<React.SetStateAction<AuthUser | null>>;
  onAuthSuccess: (nextUser: AuthUser, token: string) => void;
}

function AppView({
  route,
  setRoute,
  adminSection,
  setAdminSection,
  globalSearchQuery,
  setGlobalSearchQuery,
  selectedHospitalId,
  setSelectedHospitalId,
  compareIds,
  setCompareIds,
  prefillReport,
  setPrefillReport,
  user,
  setUser,
  onAuthSuccess,
}: AppViewProps) {
  const { signOutFirebase } = useFirebase();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [route, selectedHospitalId, adminSection]);

  const handleLogout = () => {
    clearStoredSession();
    setUser(null);
    void signOutFirebase().catch(() => {});
    if (route === 'admin' || route === 'my-activity' || route === 'profile') {
      setRoute('landing');
    }
  };

  const handleAuthChange = (nextUser: AuthUser | null, token?: string) => {
    if (nextUser && token) {
      setStoredSession(token, nextUser);
      setUser(nextUser);
    } else {
      clearStoredSession();
      setUser(null);
      void signOutFirebase().catch(() => {});
      setRoute('landing');
    }
  };

  const handleToggleCompare = useCallback(
    (hospitalId: number) => {
      setCompareIds((prev) => {
        if (prev.includes(hospitalId)) {
          return prev.filter((id) => id !== hospitalId);
        }
        if (prev.length >= 4) return prev;
        return [...prev, hospitalId];
      });
    },
    [setCompareIds],
  );

  const handleOpenHospital = (hospitalId: number) => {
    setSelectedHospitalId(hospitalId);
    setRoute('hospital');
  };

  const handleSearchHospitals = (query: string) => {
    setGlobalSearchQuery(query);
    setRoute('hospitals');
  };

  const handleReportQueue = (hospitalId: number, departmentId: number) => {
    setPrefillReport({ hospitalId, departmentId });
    setRoute(user ? 'submit' : 'auth');
  };

  const handleNavigate = (next: AppRoute) => {
    if (next === 'submit' && !prefillReport.hospitalId) {
      setPrefillReport({ hospitalId: null, departmentId: null });
    }
    if (next === 'admin' && user?.role !== 'admin') {
      setRoute('auth');
      return;
    }
    setRoute(next);
  };

  if (route === 'landing') {
    return (
      <LandingPage
        user={user}
        onNavigate={handleNavigate}
        onSearchHospitals={handleSearchHospitals}
      />
    );
  }

  return (
    <AppShell
      currentRoute={route}
      adminSection={adminSection}
      user={user}
      compareCount={compareIds.length}
      globalSearchQuery={globalSearchQuery}
      onNavigate={handleNavigate}
      onAdminSectionChange={setAdminSection}
      onGlobalSearch={handleSearchHospitals}
      onOpenHospital={handleOpenHospital}
      onLogout={handleLogout}
    >
      {route === 'dashboard' && (
        <UserDashboardPage
          user={user}
          onNavigate={handleNavigate}
          onSearchHospitals={handleSearchHospitals}
          onOpenHospital={handleOpenHospital}
        />
      )}

      {route === 'hospitals' && (
        <HomeSearchPage
          initialQuery={globalSearchQuery}
          compareIds={compareIds}
          onToggleCompare={handleToggleCompare}
          onOpenHospital={handleOpenHospital}
          onGoToCompare={() => setRoute('compare')}
        />
      )}

      {route === 'hospital' && selectedHospitalId !== null && (
        <HospitalDetailPage
          hospitalId={selectedHospitalId}
          isCompared={compareIds.includes(selectedHospitalId)}
          canAddCompare={compareIds.length < 4}
          onBack={() => setRoute('hospitals')}
          onToggleCompare={handleToggleCompare}
          onReportQueue={handleReportQueue}
        />
      )}

      {route === 'opd-queue' && <OpdQueuePage onReportQueue={handleReportQueue} />}

      {route === 'beds' && <BedAvailabilityPage onOpenHospital={handleOpenHospital} />}

      {route === 'compare' && (
        <ComparePage
          selectedIds={compareIds}
          onUpdateSelectedIds={setCompareIds}
          onOpenHospital={handleOpenHospital}
        />
      )}

      {route === 'assistant' && <AssistantPage />}

      {(route === 'submit' || route === 'my-activity' || route === 'profile') && (
        <SubmitUpdatePage
          user={user}
          initialHospitalId={prefillReport.hospitalId}
          initialDepartmentId={prefillReport.departmentId}
          defaultTab={
            route === 'my-activity' ? 'mine' : route === 'profile' ? 'account' : 'submit'
          }
          onRequireAuth={() => setRoute('auth')}
          onAuthChange={handleAuthChange}
          onSearchHospitals={handleSearchHospitals}
          onOpenHospital={handleOpenHospital}
        />
      )}

      {route === 'ml-info' && <MlInfoPage />}

      {route === 'auth' && <AuthPage onSuccess={onAuthSuccess} />}

      {route === 'admin' &&
        (user?.role === 'admin' ? (
          <AdminConsolePage
            activeSection={adminSection}
            onSectionChange={setAdminSection}
          />
        ) : (
          <div className="rounded-2xl border border-[#E05252]/40 bg-red-50 p-6 text-red-900">
            Administrator sign-in is required to view this console.
          </div>
        ))}
    </AppShell>
  );
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>('landing');
  const [adminSection, setAdminSection] = useState<AdminSection>('overview');
  const [globalSearchQuery, setGlobalSearchQuery] = useState<string>('');
  const [selectedHospitalId, setSelectedHospitalId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [prefillReport, setPrefillReport] = useState<{
    hospitalId: number | null;
    departmentId: number | null;
  }>({ hospitalId: null, departmentId: null });

  const [user, setUser] = useState<AuthUser | null>(() => {
    const token = getStoredToken();
    return token ? getStoredUser<AuthUser>() : null;
  });

  const handleAuthSuccess = useCallback(
    (nextUser: AuthUser, token: string) => {
      setStoredSession(token, nextUser);
      setUser(nextUser);
      if (route === 'auth') {
        if (nextUser.role === 'admin') {
          setAdminSection('overview');
          setRoute('admin');
        } else if (prefillReport.hospitalId) {
          setRoute('submit');
        } else {
          setRoute('dashboard');
        }
      }
    },
    [prefillReport.hospitalId, route],
  );

  return (
    <ErrorBoundary>
      <FirebaseProvider onBackendSession={handleAuthSuccess}>
        <AppView
          route={route}
          setRoute={setRoute}
          adminSection={adminSection}
          setAdminSection={setAdminSection}
          globalSearchQuery={globalSearchQuery}
          setGlobalSearchQuery={setGlobalSearchQuery}
          selectedHospitalId={selectedHospitalId}
          setSelectedHospitalId={setSelectedHospitalId}
          compareIds={compareIds}
          setCompareIds={setCompareIds}
          prefillReport={prefillReport}
          setPrefillReport={setPrefillReport}
          user={user}
          setUser={setUser}
          onAuthSuccess={handleAuthSuccess}
        />
      </FirebaseProvider>
    </ErrorBoundary>
  );
}
