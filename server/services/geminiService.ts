import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse } from '@google/genai';
import { db } from '../db/database.ts';
import { evaluateOpdStatus } from '../utils/time.ts';
import { aggregateRecentUpdates, deriveBedStatus, formatWaitRange } from '../utils/validation.ts';

export type ChatMode = 'general' | 'reasoning' | 'fast' | 'search' | 'maps';
export type AssistantRole = 'navigator' | 'analyst' | 'guide';

export interface GroundedSource {
  title: string;
  uri: string;
  sourceType: 'web' | 'maps';
  snippet?: string;
}

export interface ChatTurnInput {
  role: 'user' | 'model';
  text: string;
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const err = new Error(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.',
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function buildLiveHospitalContext(focusHospitalId?: number): {
  contextText: string;
  hospitalCount: number;
} {
  const hospitals = db
    .prepare(
      `SELECT hospital_id, name, city, type, contact
       FROM hospitals
       WHERE is_active = 1
       ${focusHospitalId ? 'AND hospital_id = ?' : ''}
       ORDER BY hospital_id ASC
       LIMIT 20`,
    )
    .all(...(focusHospitalId ? [focusHospitalId] : [])) as Array<{
    hospital_id: number;
    name: string;
    city: string;
    type: string;
    contact: string;
  }>;

  const now = new Date();
  const lines: string[] = [];

  for (const h of hospitals) {
    const depts = db
      .prepare('SELECT department_id, name, opd_timings FROM departments WHERE hospital_id = ? AND is_active = 1')
      .all(h.hospital_id) as Array<{ department_id: number; name: string; opd_timings: string }>;

    const deptSummaries = depts.slice(0, 6).map((d) => {
      const opd = evaluateOpdStatus(d.opd_timings, now);
      const updates = db
        .prepare(
          `SELECT waiting_minutes, submitted_at, validation_status
           FROM crowd_updates
           WHERE department_id = ? AND validation_status IN ('Accepted', 'Approved')
           ORDER BY submitted_at DESC
           LIMIT 10`,
        )
        .all(d.department_id) as Array<{
        waiting_minutes: number;
        submitted_at: string;
        validation_status: 'Accepted' | 'Approved' | 'Flagged' | 'Rejected';
      }>;
      const agg = aggregateRecentUpdates(updates, now);
      if (agg.reportCount > 0 && agg.weightedMeanWait !== null) {
        const rng = formatWaitRange(agg.weightedMeanWait, 6);
        return `${d.name} (${opd.isOpenNow ? 'Open' : 'Closed'}, live ${rng.rangeLow}–${rng.rangeHigh}m)`;
      }
      const hist = db
        .prepare(
          'SELECT avg_waiting_minutes FROM waiting_time_records WHERE department_id = ? ORDER BY record_time DESC LIMIT 1',
        )
        .get(d.department_id) as { avg_waiting_minutes: number } | undefined;
      return `${d.name} (${opd.isOpenNow ? 'Open' : 'Closed'}, est ~${Math.round(hist?.avg_waiting_minutes ?? 25)}m)`;
    });

    const beds = db
      .prepare(
        `SELECT b1.ward_type, b1.total_beds, b1.available_beds, b1.data_source
         FROM bed_availability_records b1
         INNER JOIN (
           SELECT ward_type, MAX(record_time) AS max_t
           FROM bed_availability_records
           WHERE hospital_id = ?
           GROUP BY ward_type
         ) b2 ON b1.ward_type = b2.ward_type AND b1.record_time = b2.max_t
         WHERE b1.hospital_id = ?`,
      )
      .all(h.hospital_id, h.hospital_id) as Array<{
      ward_type: string;
      total_beds: number;
      available_beds: number;
      data_source: string;
    }>;

    const bedText = beds
      .map((b) => `${b.ward_type}: ${b.available_beds}/${b.total_beds} (${deriveBedStatus(b.available_beds, b.total_beds)})`)
      .join('; ');

    lines.push(
      `[#${h.hospital_id}] ${h.name} (${h.city}, ${h.type}, Tel: ${h.contact}) | OPDs: ${deptSummaries.join(', ')} | Beds: ${bedText || 'N/A'}`,
    );
  }

  return {
    contextText: lines.join('\n'),
    hospitalCount: hospitals.length,
  };
}

function buildSystemInstruction(role: AssistantRole, hospitalContext: string): string {
  const rolePersonas: Record<AssistantRole, string> = {
    navigator:
      'You are the HospitEase AI OPD & Bed Navigator. Help patients pick suitable hospitals, compare estimated waiting times, understand OPD timings, and prepare for visits clearly and empathetically.',
    analyst:
      'You are the HospitEase AI Queue & Capacity Analyst. Give structured, tabular comparisons of waiting ranges, crowd confidence, ward bed ratios, and peak-hour trade-offs across hospitals.',
    guide:
      'You are the HospitEase AI Hospital Visit & Policy Guide. Answer concisely about hospital registration steps, OPD schedules, emergency helplines, and public health guidance.',
  };

  return [
    rolePersonas[role] || rolePersonas.navigator,
    'Safety rule: Never diagnose medical conditions or prescribe treatments. For medical emergencies, clearly advise dialing 112 (India) or visiting the nearest emergency ward immediately.',
    'Note that OPD waiting ranges are estimates based on live reports, feeds, and ML baseline records; always advise calling the hospital to confirm bed availability before travelling.',
    hospitalContext ? `\nCurrent HospitEase AI Hospital Snapshot:\n${hospitalContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractGroundingSources(response: GenerateContentResponse): GroundedSource[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const seen = new Set<string>();
  const out: GroundedSource[] = [];

  for (const chunk of chunks) {
    const c = chunk as {
      web?: { uri?: string; title?: string };
      maps?: {
        uri?: string;
        title?: string;
        placeAnswerSources?: { reviewSnippets?: Array<{ content?: string }> };
      };
    };

    if (c.web?.uri && !seen.has(c.web.uri)) {
      seen.add(c.web.uri);
      out.push({
        title: c.web.title || 'Web Source',
        uri: c.web.uri,
        sourceType: 'web',
      });
    } else if (c.maps?.uri && !seen.has(c.maps.uri)) {
      seen.add(c.maps.uri);
      const snippet = c.maps.placeAnswerSources?.reviewSnippets?.[0]?.content;
      out.push({
        title: c.maps.title || 'Google Maps Place',
        uri: c.maps.uri,
        sourceType: 'maps',
        snippet,
      });
    }
    if (out.length >= 10) break;
  }

  return out;
}

export async function runHospitalAssistantChat(params: {
  message: string;
  mode: ChatMode;
  systemRole: AssistantRole;
  history?: ChatTurnInput[];
  location?: { latitude: number; longitude: number } | null;
  focusHospitalId?: number;
}): Promise<{
  reply: string;
  model: string;
  mode: ChatMode;
  sources: GroundedSource[];
  grounded_hospital_count: number;
}> {
  const ai = getGeminiClient();
  const { contextText, hospitalCount } = buildLiveHospitalContext(params.focusHospitalId);
  const systemInstruction = buildSystemInstruction(params.systemRole, contextText);

  const historyEntries = (params.history || [])
    .slice(-16)
    .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim())
    .map((h) => ({
      role: h.role,
      parts: [{ text: h.text.slice(0, 6000) }],
    }));

  if (params.mode === 'search') {
    const model = 'gemini-4-hydrogen';
    const contents = [
      ...historyEntries,
      { role: 'user' as const, parts: [{ text: params.message }] },
    ];
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        tools: [{ googleSearch: {} }],
      },
    });
    return {
      reply: response.text || 'No grounded search response returned.',
      model,
      mode: 'search',
      sources: extractGroundingSources(response),
      grounded_hospital_count: hospitalCount,
    };
  }

  if (params.mode === 'maps') {
    const model = 'gemini-4-hydrogen';
    const contents = [
      ...historyEntries,
      { role: 'user' as const, parts: [{ text: params.message }] },
    ];
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        tools: [{ googleMaps: {} }],
        ...(params.location
          ? {
              toolConfig: {
                retrievalConfig: {
                  latLng: {
                    latitude: params.location.latitude,
                    longitude: params.location.longitude,
                  },
                },
              },
            }
          : {}),
      },
    });
    return {
      reply: response.text || 'No Maps-grounded response returned.',
      model,
      mode: 'maps',
      sources: extractGroundingSources(response),
      grounded_hospital_count: hospitalCount,
    };
  }

  if (params.mode === 'fast') {
    const model = 'gemini-3.1-flash-lite';
    const chat = ai.chats.create({
      model,
      history: historyEntries,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    const response = await chat.sendMessage({ message: params.message });
    return {
      reply: response.text || 'No response generated.',
      model,
      mode: 'fast',
      sources: [],
      grounded_hospital_count: hospitalCount,
    };
  }

  if (params.mode === 'reasoning') {
    const model = 'gemini-4-hydrogen';
    const chat = ai.chats.create({
      model,
      history: historyEntries,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    });
    const response = await chat.sendMessage({ message: params.message });
    return {
      reply: response.text || 'No response generated.',
      model,
      mode: 'reasoning',
      sources: [],
      grounded_hospital_count: hospitalCount,
    };
  }

  // Default: general multi-turn chat on gemini-4-hydrogen
  const model = 'gemini-4-hydrogen';
  const chat = ai.chats.create({
    model,
    history: historyEntries,
    config: {
      systemInstruction,
    },
  });
  const response = await chat.sendMessage({ message: params.message });
  return {
    reply: response.text || 'No response generated.',
    model,
    mode: 'general',
    sources: [],
    grounded_hospital_count: hospitalCount,
  };
}
