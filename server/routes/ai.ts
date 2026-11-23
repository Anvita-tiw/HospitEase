import { Router } from 'express';
import { rateLimitMiddleware } from '../middleware/auth.ts';
import {
  runHospitalAssistantChat,
  type AssistantRole,
  type ChatMode,
  type ChatTurnInput,
} from '../services/geminiService.ts';

export const aiRouter = Router();

aiRouter.get('/capabilities', (_req, res) => {
  res.json({
    gemini_configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    models: {
      general: 'gemini-4-hydrogen',
      reasoning: 'gemini-4-hydrogen',
      fast: 'gemini-3.1-flash-lite',
      search: 'gemini-4-hydrogen',
      maps: 'gemini-4-hydrogen',
      voice: 'gemini-3.8-live',
    },
  });
});

aiRouter.post('/chat', rateLimitMiddleware(30, 60_000), async (req, res) => {
  const { message, mode, systemRole, history, location, focusHospitalId } = req.body ?? {};

  if (typeof message !== 'string' || message.trim().length < 1 || message.trim().length > 4000) {
    res.status(400).json({
      code: 'INVALID_PROMPT',
      message: 'Please enter a message between 1 and 4000 characters.',
      details: null,
    });
    return;
  }

  const validModes: ChatMode[] = ['general', 'reasoning', 'fast', 'search', 'maps'];
  const cleanMode: ChatMode = validModes.includes(mode) ? mode : 'general';

  const validRoles: AssistantRole[] = ['navigator', 'analyst', 'guide'];
  const cleanRole: AssistantRole = validRoles.includes(systemRole) ? systemRole : 'navigator';

  const cleanHistory: ChatTurnInput[] = Array.isArray(history)
    ? history
        .slice(-16)
        .filter(
          (h): h is ChatTurnInput =>
            Boolean(h) &&
            (h.role === 'user' || h.role === 'model') &&
            typeof h.text === 'string' &&
            h.text.trim().length > 0,
        )
    : [];

  let cleanLocation: { latitude: number; longitude: number } | null = null;
  if (
    location &&
    typeof location.latitude === 'number' &&
    typeof location.longitude === 'number' &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 &&
    Math.abs(location.longitude) <= 180
  ) {
    cleanLocation = { latitude: location.latitude, longitude: location.longitude };
  }

  const cleanHospitalId =
    focusHospitalId !== undefined && Number.isInteger(Number(focusHospitalId)) && Number(focusHospitalId) > 0
      ? Number(focusHospitalId)
      : undefined;

  try {
    const result = await runHospitalAssistantChat({
      message: message.trim(),
      mode: cleanMode,
      systemRole: cleanRole,
      history: cleanHistory,
      location: cleanLocation,
      focusHospitalId: cleanHospitalId,
    });
    res.json(result);
  } catch (err) {
    const status =
      (err as { statusCode?: number; status?: number }).statusCode ||
      (err as { status?: number }).status ||
      500;
    let msg = err instanceof Error ? err.message : 'Unable to generate assistant response.';
    try {
      const parsed = JSON.parse(msg) as { error?: { message?: string; code?: number } };
      if (parsed?.error?.message) {
        msg = parsed.error.message;
      }
    } catch {
      // msg is already plain text
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      code: status === 429 ? 'GEMINI_QUOTA_EXCEEDED' : 'GEMINI_REQUEST_FAILED',
      message: msg,
      details: null,
    });
  }
});
