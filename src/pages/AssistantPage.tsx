import {
  Bot,
  Compass,
  ExternalLink,
  Globe,
  Loader2,
  MapPin,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFirebase } from '../contexts/FirebaseContext.tsx';
import { apiFetch, ApiError } from '../lib/api.ts';
import type {
  AssistantChatMode,
  AssistantRole,
  GroundedSource,
  HospitalListItem,
} from '../types.ts';

interface LocalChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  model?: string;
  sources?: GroundedSource[];
}

interface TranscriptEntry {
  id: string;
  speaker: 'You' | 'HospitEase Voice';
  text: string;
  at: string;
}

function pcmFloat32ToBase64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export function AssistantPage() {
  const {
    firebaseUser,
    chatSessions,
    signInWithGoogle,
    createChatSession,
    appendChatTurn,
    subscribeSessionMessages,
    deleteChatSession,
  } = useFirebase();

  const [activeTab, setActiveTab] = useState<'chat' | 'voice'>('chat');
  const [mode, setMode] = useState<Exclude<AssistantChatMode, 'voice'>>('general');
  const [systemRole, setSystemRole] = useState<AssistantRole>('navigator');
  const [focusHospitalId, setFocusHospitalId] = useState<number | ''>('');
  const [hospitals, setHospitals] = useState<HospitalListItem[]>([]);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [promptInput, setPromptInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locLoading, setLocLoading] = useState(false);

  // Voice conversation state (gemini-3.8-live)
  const [voiceState, setVoiceState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [voiceTextInput, setVoiceTextInput] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  useEffect(() => {
    apiFetch<{ hospitals: HospitalListItem[] }>('/api/hospitals?page=1&limit=100')
      .then((res) => setHospitals(res.hospitals))
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Subscribe to Firestore session messages when a persisted session is selected
  useEffect(() => {
    if (!firebaseUser || !activeSessionId) return;
    const unsub = subscribeSessionMessages(
      activeSessionId,
      (docs) => {
        setMessages(
          docs.map((d) => ({
            id: d.id,
            role: d.role,
            text: d.text,
            model: d.model,
            sources: d.sources,
          })),
        );
      },
      (errMsg) => setChatError(errMsg),
    );
    return () => unsub();
  }, [firebaseUser, activeSessionId, subscribeSessionMessages]);

  const stopVoiceSession = useCallback(() => {
    try {
      processorRef.current?.disconnect();
    } catch {}
    processorRef.current = null;

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {}
    }
    activeSourcesRef.current.clear();

    if (inputAudioCtxRef.current) {
      void inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      void outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    nextStartTimeRef.current = 0;
    setVoiceState('idle');
  }, []);

  useEffect(() => {
    return () => stopVoiceSession();
  }, [stopVoiceSession]);

  const requestGeolocation = () => {
    if (!navigator.geolocation) {
      setChatError('Browser geolocation is unavailable in this environment.');
      return;
    }
    setLocLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        setLocLoading(false);
      },
      () => {
        setLocLoading(false);
        setChatError('Location permission denied. Maps grounding will still work using city names in your prompt.');
      },
      { timeout: 6000 },
    );
  };

  const handleNewChat = () => {
    setActiveSessionId(null);
    setMessages([]);
    setChatError(null);
  };

  const handleSendMessage = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? promptInput).trim();
    if (!text || sending) return;

    setChatError(null);
    if (!overridePrompt) setPromptInput('');
    setSending(true);

    const priorHistory = messages.map((m) => ({ role: m.role, text: m.text }));
    const optimisticUser: LocalChatMessage = {
      id: `local_u_${Date.now()}`,
      role: 'user',
      text,
    };

    if (!activeSessionId || !firebaseUser) {
      setMessages((prev) => [...prev, optimisticUser]);
    }

    try {
      let currentSessionId = activeSessionId;
      if (firebaseUser && !currentSessionId) {
        const modelTag = mode === 'fast' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';
        currentSessionId = await createChatSession({
          title: text.slice(0, 80),
          mode,
          model: modelTag,
          systemRole,
        });
        setActiveSessionId(currentSessionId);
      }

      if (firebaseUser && currentSessionId) {
        await appendChatTurn({
          sessionId: currentSessionId,
          role: 'user',
          text,
          nextMessageCount: priorHistory.length + 1,
          mode,
          systemRole,
          title: priorHistory.length === 0 ? text.slice(0, 80) : undefined,
        });
      }

      const res = await apiFetch<{
        reply: string;
        model: string;
        mode: Exclude<AssistantChatMode, 'voice'>;
        sources: GroundedSource[];
      }>('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          mode,
          systemRole,
          history: priorHistory,
          location: mode === 'maps' ? userLocation : null,
          focusHospitalId: focusHospitalId || undefined,
        }),
      });

      if (firebaseUser && currentSessionId) {
        await appendChatTurn({
          sessionId: currentSessionId,
          role: 'model',
          text: res.reply,
          model: res.model,
          sources: res.sources,
          nextMessageCount: priorHistory.length + 2,
          mode,
          systemRole,
        });
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `local_m_${Date.now()}`,
            role: 'model',
            text: res.reply,
            model: res.model,
            sources: res.sources,
          },
        ]);
      }
    } catch (err) {
      setChatError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unable to send message.');
    } finally {
      setSending(false);
    }
  };

  const startVoiceSession = async () => {
    setVoiceError(null);
    setVoiceState('connecting');
    setTranscripts([]);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      await inputCtx.resume();
      await outputCtx.resume();
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProto}//${window.location.host}/api/live-voice`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(String(event.data)) as {
          ready?: boolean;
          audio?: string;
          inputTranscript?: string;
          outputTranscript?: string;
          interrupted?: boolean;
          error?: string;
          closed?: boolean;
        };

        if (data.ready) {
          setVoiceState('live');
          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (ev) => {
            if (wsRef.current?.readyState !== WebSocket.OPEN) return;
            const channelData = ev.inputBuffer.getChannelData(0);
            const b64 = pcmFloat32ToBase64(channelData);
            wsRef.current.send(JSON.stringify({ audio: b64 }));
          };

          source.connect(processor);
          processor.connect(inputCtx.destination);
        }

        if (data.audio && outputAudioCtxRef.current) {
          const ctx = outputAudioCtxRef.current;
          const samples = base64Pcm16ToFloat32(data.audio);
          const buffer = ctx.createBuffer(1, samples.length, 24000);
          buffer.copyToChannel(new Float32Array(samples), 0);

          const srcNode = ctx.createBufferSource();
          srcNode.buffer = buffer;
          srcNode.connect(ctx.destination);

          const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
          srcNode.start(startAt);
          nextStartTimeRef.current = startAt + buffer.duration;
          activeSourcesRef.current.add(srcNode);
          srcNode.onended = () => activeSourcesRef.current.delete(srcNode);
        }

        if (data.interrupted) {
          for (const src of activeSourcesRef.current) {
            try {
              src.stop();
            } catch {}
          }
          activeSourcesRef.current.clear();
          if (outputAudioCtxRef.current) {
            nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
          }
        }

        if (data.inputTranscript) {
          const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          setTranscripts((prev) => [
            ...prev,
            { id: `in_${Date.now()}_${Math.random()}`, speaker: 'You', text: data.inputTranscript!, at: time },
          ]);
        }

        if (data.outputTranscript) {
          const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          setTranscripts((prev) => [
            ...prev,
            {
              id: `out_${Date.now()}_${Math.random()}`,
              speaker: 'HospitEase Voice',
              text: data.outputTranscript!,
              at: time,
            },
          ]);
        }

        if (data.error) {
          setVoiceError(data.error);
          setVoiceState('error');
        }
      };

      ws.onerror = () => {
        setVoiceError('Live voice WebSocket connection failed.');
        setVoiceState('error');
      };

      ws.onclose = () => {
        setVoiceState((prev) => (prev === 'error' ? 'error' : 'idle'));
      };
    } catch (err) {
      stopVoiceSession();
      setVoiceState('error');
      setVoiceError(
        err instanceof Error
          ? err.message
          : 'Microphone access is required for real-time voice conversations.',
      );
    }
  };

  const sendVoiceTextPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const txt = voiceTextInput.trim();
    if (!txt || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ text: txt }));
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    setTranscripts((prev) => [...prev, { id: `txt_${Date.now()}`, speaker: 'You', text: txt, at: time }]);
    setVoiceTextInput('');
  };

  const modeOptions: Array<{
    id: Exclude<AssistantChatMode, 'voice'>;
    label: string;
    modelHint: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'general', label: 'General Chat', modelHint: 'gemini-4-hydrogen', icon: Bot },
    { id: 'reasoning', label: 'Deep Reasoning', modelHint: 'gemini-4-hydrogen (High Thinking)', icon: Sparkles },
    { id: 'fast', label: 'Fast Lookup', modelHint: 'gemini-3.1-flash-lite', icon: Zap },
    { id: 'search', label: 'Google Search', modelHint: 'gemini-4-hydrogen + Web', icon: Globe },
    { id: 'maps', label: 'Google Maps', modelHint: 'gemini-4-hydrogen + Maps', icon: MapPin },
  ];

  const starterPrompts = [
    {
      label: 'Compare General Medicine waits',
      mode: 'reasoning' as const,
      prompt: 'Compare General Medicine OPD waiting times and available beds across Indore hospitals right now.',
    },
    {
      label: 'Search latest ABHA OPD rules',
      mode: 'search' as const,
      prompt: 'Search current ABHA Scan and Share OPD queue registration guidelines and hospital helpline numbers in Madhya Pradesh.',
    },
    {
      label: 'Find nearby 24/7 hospitals on Maps',
      mode: 'maps' as const,
      prompt: 'Find major multi-specialty and government hospitals in Indore with Google Maps links.',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#12304A]">
              HospitEase AI Assistant &amp; Live Voice
            </h1>
            <p className="mt-1 text-sm text-[#718096]">
              Multi-turn hospital guidance grounded in live OPD/bed data, Google Search, Google Maps, and real-time voice conversations.
            </p>
          </div>

          <div className="inline-flex rounded-xl border border-slate-200 bg-[#F5F8FC] p-1">
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`inline-flex min-h-[38px] items-center gap-2 rounded-lg px-4 text-xs font-semibold transition-colors ${
                activeTab === 'chat' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096] hover:text-[#12304A]'
              }`}
            >
              <Bot className="h-4 w-4" />
              <span>Multi-Turn Chat &amp; Grounding</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('voice')}
              className={`inline-flex min-h-[38px] items-center gap-2 rounded-lg px-4 text-xs font-semibold transition-colors ${
                activeTab === 'voice' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096] hover:text-[#12304A]'
              }`}
            >
              <Mic className="h-4 w-4" />
              <span>Live Voice (gemini-3.8-live)</span>
            </button>
          </div>
        </div>
      </section>

      {activeTab === 'chat' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Session History Sidebar (Firestore Sync) */}
          <aside className="rounded-2xl border border-slate-200 bg-white p-4 lg:col-span-3 flex flex-col justify-between gap-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-[#12304A]">
                  Conversation History
                </h2>
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#1769AA] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#125388]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>New</span>
                </button>
              </div>

              {!firebaseUser ? (
                <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-3.5 text-xs text-[#243447] space-y-2.5">
                  <p className="font-semibold text-[#12304A]">Sync chats across devices</p>
                  <p className="text-[#718096]">
                    Sign in with Google to persist your conversation threads and bookmarked hospitals in Firestore.
                  </p>
                  <button
                    type="button"
                    onClick={() => void signInWithGoogle()}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#12304A] hover:bg-slate-50"
                  >
                    Continue with Google
                  </button>
                </div>
              ) : chatSessions.length === 0 ? (
                <p className="py-6 text-center text-xs text-[#718096]">
                  No saved threads yet. Start a message on the right to save automatically.
                </p>
              ) : (
                <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                  {chatSessions.map((s) => (
                    <div
                      key={s.id}
                      className={`group flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                        activeSessionId === s.id
                          ? 'border-[#1769AA]/40 bg-[#1769AA]/8 text-[#12304A]'
                          : 'border-slate-100 bg-[#F5F8FC] text-[#243447] hover:border-slate-300'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSessionId(s.id);
                          if (s.mode !== 'voice') setMode(s.mode);
                          setSystemRole(s.systemRole);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate font-semibold">{s.title}</div>
                        <div className="mt-0.5 text-[11px] text-[#718096]">
                          {s.mode} · {s.messageCount} msgs
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label="Delete session"
                        onClick={() => {
                          void deleteChatSession(s.id);
                          if (activeSessionId === s.id) handleNewChat();
                        }}
                        className="rounded p-1 text-[#718096] hover:bg-red-50 hover:text-[#E05252]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 pt-3 text-[11px] text-[#718096]">
              Safety note: Responses are informational only. For emergencies, dial <strong className="text-[#12304A]">112</strong>.
            </div>
          </aside>

          {/* Main Chat Workspace */}
          <section className="flex flex-col rounded-2xl border border-slate-200 bg-white lg:col-span-9 overflow-hidden">
            {/* Configuration Controls */}
            <div className="border-b border-slate-200 bg-[#F5F8FC] p-4 space-y-3">
              <div className="flex flex-wrap gap-2">
                {modeOptions.map((opt) => {
                  const Icon = opt.icon;
                  const active = mode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setMode(opt.id)}
                      className={`inline-flex min-h-[38px] items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        active
                          ? 'border-[#1769AA] bg-[#1769AA] text-white'
                          : 'border-slate-200 bg-white text-[#243447] hover:bg-slate-50'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2 text-[#718096]">
                  <span className="font-semibold text-[#12304A]">Assistant Role:</span>
                  <select
                    value={systemRole}
                    onChange={(e) => setSystemRole(e.target.value as AssistantRole)}
                    className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-medium text-[#243447]"
                  >
                    <option value="navigator">OPD &amp; Bed Navigator</option>
                    <option value="analyst">Queue &amp; Capacity Analyst</option>
                    <option value="guide">Hospital Visit &amp; Policy Guide</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 text-[#718096]">
                  <span className="font-semibold text-[#12304A]">Focus Hospital:</span>
                  <select
                    value={focusHospitalId}
                    onChange={(e) =>
                      setFocusHospitalId(e.target.value ? Number(e.target.value) : '')
                    }
                    className="min-h-[34px] max-w-[230px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-medium text-[#243447]"
                  >
                    <option value="">All active hospitals</option>
                    {hospitals.map((h) => (
                      <option key={h.hospital_id} value={h.hospital_id}>
                        {h.name} ({h.city})
                      </option>
                    ))}
                  </select>
                </label>

                {mode === 'maps' && (
                  <button
                    type="button"
                    onClick={requestGeolocation}
                    disabled={locLoading}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-[#1769AA] hover:bg-slate-50"
                  >
                    <Compass className="h-3.5 w-3.5" />
                    <span>
                      {userLocation
                        ? `GPS Locked (${userLocation.latitude.toFixed(2)}, ${userLocation.longitude.toFixed(2)})`
                        : locLoading
                          ? 'Locating...'
                          : 'Share GPS for Nearby Maps'}
                    </span>
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable Messages */}
            <div className="flex-1 space-y-4 overflow-y-auto p-5 min-h-[380px] max-h-[540px]">
              {messages.length === 0 ? (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#1769AA]/10 text-[#1769AA]">
                    <Bot className="h-6 w-6" />
                  </div>
                  <div className="mx-auto max-w-md space-y-1">
                    <h3 className="font-display text-base font-semibold text-[#12304A]">
                      Ask about OPD queues, ward beds, or hospital directions
                    </h3>
                    <p className="text-xs text-[#718096]">
                      Running on {mode === 'fast' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen'} with live HospitEase SQLite telemetry.
                    </p>
                  </div>
                  <div className="mx-auto flex max-w-2xl flex-wrap justify-center gap-2 pt-2">
                    {starterPrompts.map((sp) => (
                      <button
                        key={sp.label}
                        type="button"
                        onClick={() => {
                          setMode(sp.mode);
                          setPromptInput(sp.prompt);
                        }}
                        className="rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 py-2 text-xs font-semibold text-[#12304A] hover:border-[#1769AA]/40 hover:bg-white"
                      >
                        {sp.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        m.role === 'user'
                          ? 'bg-[#1769AA] text-white'
                          : 'border border-slate-200 bg-[#F5F8FC] text-[#243447]'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{m.text}</div>

                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-3 border-t border-slate-200/80 pt-2.5 space-y-1.5">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#718096]">
                            {m.sources[0].sourceType === 'maps'
                              ? 'Google Maps Places & Directions'
                              : 'Google Search Grounded Sources'}
                          </div>
                          <ul className="space-y-1">
                            {m.sources.map((src, idx) => (
                              <li key={`${src.uri}_${idx}`} className="text-xs">
                                <a
                                  href={src.uri}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 font-semibold text-[#1769AA] hover:underline"
                                >
                                  {src.sourceType === 'maps' ? (
                                    <MapPin className="h-3.5 w-3.5 shrink-0 text-[#16A6A1]" />
                                  ) : (
                                    <Globe className="h-3.5 w-3.5 shrink-0 text-[#1769AA]" />
                                  )}
                                  <span>{src.title}</span>
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                                {src.snippet && (
                                  <p className="mt-0.5 pl-5 text-[11px] text-[#718096]">{src.snippet}</p>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    {m.model && m.role === 'model' && (
                      <span className="mt-1 px-1 text-[11px] text-[#718096] font-mono">
                        {m.model}
                      </span>
                    )}
                  </div>
                ))
              )}

              {sending && (
                <div className="flex items-center gap-2 text-xs text-[#718096]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#1769AA]" />
                  <span>Generating response...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {chatError && (
              <div role="alert" className="mx-5 mb-3 rounded-xl border border-[#E05252]/40 bg-red-50 px-4 py-2.5 text-xs text-red-900">
                {chatError}
              </div>
            )}

            {/* Input Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendMessage();
              }}
              className="border-t border-slate-200 bg-white p-4 flex items-center gap-3"
            >
              <input
                type="text"
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder={
                  mode === 'search'
                    ? 'Ask with live Google Search grounding...'
                    : mode === 'maps'
                      ? 'Ask about nearby hospitals or directions via Google Maps...'
                      : 'Ask about OPD waiting times, bed availability, or hospital comparisons...'
                }
                className="min-h-[44px] flex-1 rounded-xl border border-slate-300 bg-[#F5F8FC] px-4 text-sm text-[#12304A] focus:border-[#1769AA] focus:bg-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !promptInput.trim()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#1769AA] px-5 py-2 text-sm font-semibold text-white hover:bg-[#125388] disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                <span>Send</span>
              </button>
            </form>
          </section>
        </div>
      ) : (
        /* Live Voice Tab (gemini-3.8-live) */
        <section className="rounded-2xl border border-slate-200 bg-white p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-5">
            <div className="space-y-1">
              <h2 className="font-display text-lg font-semibold text-[#12304A]">
                Real-Time Voice Assistant (`gemini-3.8-live`)
              </h2>
              <p className="text-xs text-[#718096]">
                Streams 16 kHz microphone audio to Gemini Live API and plays back 24 kHz spoken guidance with live transcriptions.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <span className="font-mono text-xs font-semibold text-[#243447]">
                Status:{' '}
                <span
                  className={
                    voiceState === 'live'
                      ? 'text-[#16A36A]'
                      : voiceState === 'error'
                        ? 'text-[#E05252]'
                        : 'text-[#1769AA]'
                  }
                >
                  {voiceState === 'live'
                    ? 'Live Microphone Active'
                    : voiceState === 'connecting'
                      ? 'Connecting...'
                      : voiceState === 'error'
                        ? 'Connection Error'
                        : 'Ready'}
                </span>
              </span>

              {voiceState === 'live' || voiceState === 'connecting' ? (
                <button
                  type="button"
                  onClick={stopVoiceSession}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#E05252] px-5 py-2 text-sm font-semibold text-white hover:bg-[#B91C1C]"
                >
                  <PhoneOff className="h-4 w-4" />
                  <span>End Voice Call</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void startVoiceSession()}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#16A6A1] px-5 py-2 text-sm font-semibold text-white hover:bg-[#128783]"
                >
                  <Mic className="h-4 w-4" />
                  <span>Start Voice Conversation</span>
                </button>
              )}
            </div>
          </div>

          {voiceError && (
            <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 px-4 py-3 text-sm text-red-900">
              {voiceError}
            </div>
          )}

          {/* Live Transcript Panel */}
          <div className="rounded-2xl border border-slate-200 bg-[#F5F8FC] p-5 min-h-[280px] max-h-[420px] overflow-y-auto space-y-3">
            {transcripts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-[#718096]">
                {voiceState === 'live' ? (
                  <Mic className="h-8 w-8 text-[#16A36A]" />
                ) : (
                  <MicOff className="h-8 w-8 text-slate-400" />
                )}
                <p className="mt-3 text-sm font-medium text-[#12304A]">
                  {voiceState === 'live'
                    ? 'Listening — ask naturally about open OPDs, waiting estimates, or ICU beds.'
                    : 'Press "Start Voice Conversation" to speak directly with HospitEase AI.'}
                </p>
                <p className="mt-1 text-xs">
                  Example: &ldquo;Which hospital in Indore has General Medicine open now with low wait?&rdquo;
                </p>
              </div>
            ) : (
              transcripts.map((t) => (
                <div
                  key={t.id}
                  className={`rounded-xl border p-3 text-sm ${
                    t.speaker === 'You'
                      ? 'ml-auto max-w-[80%] border-[#1769AA]/30 bg-white text-[#12304A]'
                      : 'mr-auto max-w-[85%] border-slate-200 bg-[#12304A] text-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 text-[11px] opacity-75">
                    <span className="font-semibold">{t.speaker}</span>
                    <span className="font-mono tabular-nums">{t.at}</span>
                  </div>
                  <p className="mt-1">{t.text}</p>
                </div>
              ))
            )}
          </div>

          {voiceState === 'live' && (
            <form onSubmit={sendVoiceTextPrompt} className="flex items-center gap-3">
              <input
                type="text"
                value={voiceTextInput}
                onChange={(e) => setVoiceTextInput(e.target.value)}
                placeholder="Or type a message into the active voice session..."
                className="min-h-[42px] flex-1 rounded-xl border border-slate-300 bg-[#F5F8FC] px-4 text-sm text-[#12304A]"
              />
              <button
                type="submit"
                disabled={!voiceTextInput.trim()}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-[#1769AA] px-4 py-2 text-xs font-semibold text-white hover:bg-[#125388] disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Send Text</span>
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
