import type { Server as HttpServer } from 'node:http';
import { Modality, type LiveServerMessage } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import { buildLiveHospitalContext, getGeminiClient } from './geminiService.ts';

export function attachLiveVoiceWebSocket(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url ? request.url.split('?')[0] : '';
    if (pathname !== '/api/live-voice') {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (clientWs: WebSocket) => {
    let session: Awaited<ReturnType<ReturnType<typeof getGeminiClient>['live']['connect']>> | null = null;

    const sendJson = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = getGeminiClient();
      const { contextText } = buildLiveHospitalContext();

      session = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Zephyr' },
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction:
            'You are the HospitEase AI Live Voice Assistant. Keep spoken answers concise, warm, and factual. ' +
            'Help patients find open OPD departments, estimated waiting ranges, and ward bed availability. ' +
            'Always remind callers that waiting times are estimates and to dial 112 in medical emergencies. ' +
            `Live Hospital Snapshot:\n${contextText}`,
        },
        callbacks: {
          onopen: () => {
            sendJson({ ready: true, model: 'gemini-3.8-live' });
          },
          onmessage: (message: LiveServerMessage) => {
            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              sendJson({ inputTranscript: content.inputTranscription.text });
            }
            if (content?.outputTranscription?.text) {
              sendJson({ outputTranscript: content.outputTranscription.text });
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                sendJson({ audio: part.inlineData.data });
              }
            }
            if (content?.interrupted) {
              sendJson({ interrupted: true });
            }
            if (content?.turnComplete) {
              sendJson({ turnComplete: true });
            }
          },
          onerror: (err) => {
            sendJson({ error: err instanceof Error ? err.message : 'Live voice stream encountered an error.' });
          },
          onclose: () => {
            sendJson({ closed: true });
          },
        },
      });
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Unable to connect to Gemini Live Voice API.';
      try {
        const parsed = JSON.parse(message) as { error?: { message?: string } };
        if (parsed?.error?.message) message = parsed.error.message;
      } catch {
        // Already plain text
      }
      sendJson({ error: message });
      clientWs.close();
      return;
    }

    clientWs.on('message', (raw) => {
      if (!session) return;
      try {
        const parsed = JSON.parse(raw.toString()) as { audio?: string; text?: string };
        if (typeof parsed.audio === 'string' && parsed.audio.length > 0) {
          session.sendRealtimeInput({
            audio: {
              data: parsed.audio,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } else if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
          session.sendRealtimeInput({
            text: parsed.text.trim().slice(0, 1000),
          });
        }
      } catch {
        // Ignore malformed client audio packets
      }
    });

    clientWs.on('close', () => {
      try {
        session?.close();
      } catch {
        // Ignore close errors
      }
      session = null;
    });
  });
}
