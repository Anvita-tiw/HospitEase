import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '../lib/api.ts';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase.ts';
import type {
  AssistantChatMode,
  AssistantRole,
  AuthUser,
  FirestoreChatMessage,
  FirestoreChatSession,
  GroundedSource,
  SavedHospitalDoc,
} from '../types.ts';

interface FirebaseContextValue {
  firebaseUser: FirebaseUser | null;
  authReady: boolean;
  savedHospitals: SavedHospitalDoc[];
  chatSessions: FirestoreChatSession[];
  signInWithGoogle: () => Promise<{ user: AuthUser; token: string }>;
  signOutFirebase: () => Promise<void>;
  isHospitalSaved: (hospitalId: number) => boolean;
  toggleSaveHospital: (hospital: {
    hospital_id: number;
    name: string;
    city: string;
    type?: string;
  }) => Promise<boolean>;
  updateSavedHospitalNotes: (hospitalId: number, notes: string) => Promise<void>;
  createChatSession: (params: {
    title: string;
    mode: AssistantChatMode;
    model: string;
    systemRole: AssistantRole;
  }) => Promise<string>;
  appendChatTurn: (params: {
    sessionId: string;
    role: 'user' | 'model';
    text: string;
    model?: string;
    sources?: GroundedSource[];
    nextMessageCount: number;
    mode: AssistantChatMode;
    systemRole: AssistantRole;
    title?: string;
  }) => Promise<void>;
  subscribeSessionMessages: (
    sessionId: string,
    onMessages: (msgs: FirestoreChatMessage[]) => void,
    onErr?: (msg: string) => void,
  ) => () => void;
  deleteChatSession: (sessionId: string) => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

function tsToMs(value: unknown): number {
  if (!value) return Date.now();
  if (typeof (value as Timestamp).toMillis === 'function') {
    return (value as Timestamp).toMillis();
  }
  return Date.now();
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

async function ensureUserProfileDoc(fbUser: FirebaseUser): Promise<void> {
  const uid = sanitizeId(fbUser.uid);
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);
  try {
    const snap = await getDoc(ref);
    const displayName = (fbUser.displayName || fbUser.email?.split('@')[0] || 'Patient').trim().slice(0, 80);
    const email = (fbUser.email || '').trim().slice(0, 160);
    const photoURL = (fbUser.photoURL || '').trim().slice(0, 512);

    if (!snap.exists()) {
      await setDoc(ref, {
        uid,
        displayName,
        email,
        ...(photoURL ? { photoURL } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        displayName,
        ...(photoURL ? { photoURL } : {}),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export function FirebaseProvider({
  onBackendSession,
  children,
}: {
  onBackendSession?: (user: AuthUser, token: string) => void;
  children: ReactNode;
}) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [savedHospitals, setSavedHospitals] = useState<SavedHospitalDoc[]>([]);
  const [chatSessions, setChatSessions] = useState<FirestoreChatSession[]>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setFirebaseUser(nextUser);
      setAuthReady(true);
      if (nextUser && nextUser.emailVerified) {
        try {
          await ensureUserProfileDoc(nextUser);
        } catch {
          // Handled via handleFirestoreError logging
        }
      } else {
        setSavedHospitals([]);
        setChatSessions([]);
      }
    });
    return () => unsub();
  }, []);

  // Attach real-time Firestore listeners only when auth is ready and verified
  useEffect(() => {
    if (!authReady || !firebaseUser || !firebaseUser.emailVerified) {
      setSavedHospitals([]);
      setChatSessions([]);
      return;
    }

    const uid = sanitizeId(firebaseUser.uid);
    const savedPath = `users/${uid}/savedHospitals`;
    const savedQ = query(collection(db, 'users', uid, 'savedHospitals'), where('userId', '==', uid));
    const unsubSaved = onSnapshot(
      savedQ,
      (snap) => {
        const items: SavedHospitalDoc[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              userId: String(data.userId || uid),
              hospitalId: Number(data.hospitalId || 0),
              hospitalName: String(data.hospitalName || ''),
              city: String(data.city || ''),
              hospitalType: typeof data.hospitalType === 'string' ? data.hospitalType : undefined,
              notes: typeof data.notes === 'string' ? data.notes : undefined,
              createdAtMs: tsToMs(data.createdAt),
            };
          })
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setSavedHospitals(items);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, savedPath);
        } catch {
          // Logged cleanly
        }
      },
    );

    const sessionsPath = `users/${uid}/chatSessions`;
    const sessionsQ = query(collection(db, 'users', uid, 'chatSessions'), where('userId', '==', uid));
    const unsubSessions = onSnapshot(
      sessionsQ,
      (snap) => {
        const items: FirestoreChatSession[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              userId: String(data.userId || uid),
              title: String(data.title || 'Assistant Chat'),
              mode: (data.mode as AssistantChatMode) || 'general',
              model: String(data.model || 'gemini-4-hydrogen'),
              systemRole: (data.systemRole as AssistantRole) || 'navigator',
              messageCount: Number(data.messageCount || 0),
              updatedAtMs: tsToMs(data.updatedAt),
            };
          })
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        setChatSessions(items);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, sessionsPath);
        } catch {
          // Logged cleanly
        }
      },
    );

    return () => {
      unsubSaved();
      unsubSessions();
    };
  }, [authReady, firebaseUser]);

  const signInWithGoogle = useCallback(async () => {
    const cred = await signInWithPopup(auth, googleProvider);
    await ensureUserProfileDoc(cred.user);
    const idToken = await cred.user.getIdToken();
    const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/firebase', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    });
    if (onBackendSession) {
      onBackendSession(res.user, res.token);
    }
    return res;
  }, [onBackendSession]);

  const signOutFirebase = useCallback(async () => {
    await signOut(auth);
  }, []);

  const isHospitalSaved = useCallback(
    (hospitalId: number) => savedHospitals.some((s) => s.hospitalId === hospitalId),
    [savedHospitals],
  );

  const toggleSaveHospital = useCallback(
    async (hospital: { hospital_id: number; name: string; city: string; type?: string }) => {
      if (!firebaseUser) {
        throw new Error('Please sign in with Google to save hospitals across devices.');
      }
      const uid = sanitizeId(firebaseUser.uid);
      const docId = `hospital_${hospital.hospital_id}`;
      const path = `users/${uid}/savedHospitals/${docId}`;
      const ref = doc(db, 'users', uid, 'savedHospitals', docId);
      const exists = savedHospitals.some((s) => s.id === docId || s.hospitalId === hospital.hospital_id);

      try {
        await ensureUserProfileDoc(firebaseUser);
        if (exists) {
          await deleteDoc(ref);
          return false;
        }
        await setDoc(ref, {
          userId: uid,
          hospitalId: hospital.hospital_id,
          hospitalName: hospital.name.trim().slice(0, 160),
          city: hospital.city.trim().slice(0, 60),
          ...(hospital.type ? { hospitalType: hospital.type.trim().slice(0, 60) } : {}),
          createdAt: serverTimestamp(),
        });
        return true;
      } catch (err) {
        handleFirestoreError(err, exists ? OperationType.DELETE : OperationType.CREATE, path);
      }
    },
    [firebaseUser, savedHospitals],
  );

  const updateSavedHospitalNotes = useCallback(
    async (hospitalId: number, notes: string) => {
      if (!firebaseUser) return;
      const uid = sanitizeId(firebaseUser.uid);
      const docId = `hospital_${hospitalId}`;
      const path = `users/${uid}/savedHospitals/${docId}`;
      try {
        await updateDoc(doc(db, 'users', uid, 'savedHospitals', docId), {
          notes: notes.trim().slice(0, 300),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [firebaseUser],
  );

  const createChatSession = useCallback(
    async (params: {
      title: string;
      mode: AssistantChatMode;
      model: string;
      systemRole: AssistantRole;
    }) => {
      if (!firebaseUser) {
        throw new Error('Google Sign-In required for cloud chat persistence.');
      }
      const uid = sanitizeId(firebaseUser.uid);
      const sessionId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const path = `users/${uid}/chatSessions/${sessionId}`;
      try {
        await ensureUserProfileDoc(firebaseUser);
        await setDoc(doc(db, 'users', uid, 'chatSessions', sessionId), {
          userId: uid,
          title: params.title.trim().slice(0, 120) || 'Hospital Assistant Chat',
          mode: params.mode,
          model: params.model.slice(0, 64),
          systemRole: params.systemRole.slice(0, 64),
          messageCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return sessionId;
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [firebaseUser],
  );

  const appendChatTurn = useCallback(
    async (params: {
      sessionId: string;
      role: 'user' | 'model';
      text: string;
      model?: string;
      sources?: GroundedSource[];
      nextMessageCount: number;
      mode: AssistantChatMode;
      systemRole: AssistantRole;
      title?: string;
    }) => {
      if (!firebaseUser) return;
      const uid = sanitizeId(firebaseUser.uid);
      const cleanSessionId = sanitizeId(params.sessionId);
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const msgPath = `users/${uid}/chatSessions/${cleanSessionId}/messages/${msgId}`;

      try {
        const batch = writeBatch(db);
        const sessionRef = doc(db, 'users', uid, 'chatSessions', cleanSessionId);
        const msgRef = doc(db, 'users', uid, 'chatSessions', cleanSessionId, 'messages', msgId);

        const cleanSources = (params.sources || []).slice(0, 10).map((s) => ({
          title: (s.title || 'Source').slice(0, 200),
          uri: s.uri.slice(0, 1024),
          sourceType: s.sourceType === 'maps' ? 'maps' : 'web',
        }));

        batch.update(sessionRef, {
          ...(params.title ? { title: params.title.trim().slice(0, 120) } : {}),
          mode: params.mode,
          model: (params.model || 'gemini-4-hydrogen').slice(0, 64),
          systemRole: params.systemRole.slice(0, 64),
          messageCount: Math.min(500, Math.max(0, params.nextMessageCount)),
          updatedAt: serverTimestamp(),
        });

        batch.set(msgRef, {
          userId: uid,
          sessionId: cleanSessionId,
          role: params.role,
          text: params.text.trim().slice(0, 16000),
          ...(params.model ? { model: params.model.slice(0, 64) } : {}),
          ...(cleanSources.length > 0 ? { sources: cleanSources } : {}),
          createdAt: serverTimestamp(),
        });

        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, msgPath);
      }
    },
    [firebaseUser],
  );

  const subscribeSessionMessages = useCallback(
    (
      sessionId: string,
      onMessages: (msgs: FirestoreChatMessage[]) => void,
      onErr?: (msg: string) => void,
    ) => {
      if (!firebaseUser || !firebaseUser.emailVerified || !sessionId) {
        onMessages([]);
        return () => {};
      }
      const uid = sanitizeId(firebaseUser.uid);
      const cleanSessionId = sanitizeId(sessionId);
      const path = `users/${uid}/chatSessions/${cleanSessionId}/messages`;
      const q = query(
        collection(db, 'users', uid, 'chatSessions', cleanSessionId, 'messages'),
        where('userId', '==', uid),
      );
      return onSnapshot(
        q,
        (snap) => {
          const msgs: FirestoreChatMessage[] = snap.docs
            .map((d): FirestoreChatMessage => {
              const data = d.data();
              const role: 'user' | 'model' = data.role === 'model' ? 'model' : 'user';
              return {
                id: d.id,
                userId: String(data.userId || uid),
                sessionId: String(data.sessionId || cleanSessionId),
                role,
                text: String(data.text || ''),
                model: typeof data.model === 'string' ? data.model : undefined,
                sources: Array.isArray(data.sources) ? (data.sources as GroundedSource[]) : undefined,
                createdAtMs: tsToMs(data.createdAt),
              };
            })
            .sort((a, b) => a.createdAtMs - b.createdAtMs);
          onMessages(msgs);
        },
        (err) => {
          if (onErr) onErr(err instanceof Error ? err.message : 'Unable to load messages.');
          try {
            handleFirestoreError(err, OperationType.LIST, path);
          } catch {
            // Logged cleanly
          }
        },
      );
    },
    [firebaseUser],
  );

  const deleteChatSession = useCallback(
    async (sessionId: string) => {
      if (!firebaseUser) return;
      const uid = sanitizeId(firebaseUser.uid);
      const cleanSessionId = sanitizeId(sessionId);
      const path = `users/${uid}/chatSessions/${cleanSessionId}`;
      try {
        await deleteDoc(doc(db, 'users', uid, 'chatSessions', cleanSessionId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [firebaseUser],
  );

  return (
    <FirebaseContext.Provider
      value={{
        firebaseUser,
        authReady,
        savedHospitals,
        chatSessions,
        signInWithGoogle,
        signOutFirebase,
        isHospitalSaved,
        toggleSaveHospital,
        updateSavedHospitalNotes,
        createChatSession,
        appendChatTurn,
        subscribeSessionMessages,
        deleteChatSession,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
}

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used within a FirebaseProvider');
  }
  return ctx;
}
