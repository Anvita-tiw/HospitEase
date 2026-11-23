import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let display = error.message || 'An unexpected application error occurred.';
    try {
      const parsed = JSON.parse(display) as { error?: string; operationType?: string };
      if (parsed.error) {
        display = `${parsed.operationType ? `${parsed.operationType.toUpperCase()}: ` : ''}${parsed.error}`;
      }
    } catch {
      // Plain error message
    }
    return { hasError: true, message: display };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('HospitEase UI ErrorBoundary:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#F5F8FC] p-6">
          <div className="max-w-md rounded-2xl border border-[#E05252]/40 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-red-50 text-[#E05252]">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h1 className="mt-4 font-display text-lg font-bold text-[#12304A]">
              Something went wrong
            </h1>
            <p className="mt-2 break-words text-sm text-[#718096]">{this.state.message}</p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, message: '' });
              }}
              className="mt-5 inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#1769AA] px-5 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
            >
              <RefreshCw className="h-4 w-4" />
              <span>Try Again</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
