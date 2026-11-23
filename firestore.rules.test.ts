import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');

describe('Firestore Security Rules & Blueprint Invariants', () => {
  const rulesText = fs.readFileSync(rulesPath, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as {
    entities: Record<string, { properties: Record<string, { maxLength?: number; pattern?: string }> }>;
    firestore: Record<string, unknown>;
  };

  it('starts with rules_version = 2 and a default-deny catch-all rule', () => {
    expect(rulesText).toContain("rules_version = '2';");
    expect(rulesText).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
  });

  it('enforces email_verified == true and prevents blanket signed-in reads', () => {
    expect(rulesText).toContain('request.auth.token.email_verified == true');
    expect(rulesText).not.toMatch(/allow read:\s*if\s*isSignedIn\(\);/);
    expect(rulesText).not.toMatch(/allow list:\s*if\s*isSignedIn\(\);/);
  });

  it('covers every collection declared in firebase-blueprint.json', () => {
    expect(Object.keys(blueprint.firestore)).toEqual([
      '/users/{userId}',
      '/users/{userId}/savedHospitals/{hospitalKey}',
      '/users/{userId}/chatSessions/{sessionId}',
      '/users/{userId}/chatSessions/{sessionId}/messages/{messageId}',
      '/admins/{userId}',
    ]);

    expect(rulesText).toContain('match /admins/{userId}');
    expect(rulesText).toContain('match /users/{userId}');
    expect(rulesText).toContain('match /savedHospitals/{hospitalKey}');
    expect(rulesText).toContain('match /chatSessions/{sessionId}');
    expect(rulesText).toContain('match /messages/{messageId}');
  });

  it('synchronizes validation boundaries and atomic parent updates with the blueprint', () => {
    expect(blueprint.entities.UserProfile.properties.displayName.maxLength).toBe(80);
    expect(rulesText).toContain('data.displayName.size() <= 80');
    expect(blueprint.entities.SavedHospital.properties.notes.maxLength).toBe(300);
    expect(rulesText).toContain('data.notes.size() <= 300');
    expect(blueprint.entities.ChatMessage.properties.text.maxLength).toBe(16000);
    expect(rulesText).toContain('data.text.size() <= 16000');
    expect(rulesText).toContain('getAfter(/databases/$(database)/documents/users/$(userId)/chatSessions/$(sessionId)).data.updatedAt == request.time');
  });
});
