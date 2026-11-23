const TOKEN_KEY = 'hospitease_auth_token';
const USER_KEY = 'hospitease_auth_user';

export class ApiError extends Error {
  status: number;
  code: string;
  details: string | null;

  constructor(status: number, code: string, message: string, details: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser<T>(): T | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  onUnauthorized?: () => void,
): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && onUnauthorized) {
      clearStoredSession();
      onUnauthorized();
    }
    throw new ApiError(
      res.status,
      data.code || 'REQUEST_FAILED',
      data.message || 'Unable to complete the request. Please try again.',
      data.details || null,
    );
  }
  return data as T;
}
