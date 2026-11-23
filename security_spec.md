# Firestore Security Specification (Phase 0)

## Data Invariants
1. **User Profile Ownership & PII Isolation**: A `/users/{userId}` document can only be read or written by the authenticated, email-verified user whose `request.auth.uid == userId` (or a verified administrator), and never allows arbitrary `role` or shadow fields.
2. **Saved Hospital Master Gate**: A `/users/{userId}/savedHospitals/{hospitalKey}` document cannot exist unless the parent `/users/{userId}` document exists, `userId == request.auth.uid`, and numeric `hospitalId > 0`.
3. **Chat Session & Message Integrity**: A `/users/{userId}/chatSessions/{sessionId}/messages/{messageId}` document must match `sessionId` and `userId == request.auth.uid`, validate `role in ['user', 'model']`, bound `text.size() <= 16000` and `sources.size() <= 10`, and atomically update the parent `chatSessions/{sessionId}` `updatedAt` timestamp via `getAfter`.
4. **Verified Identity & Server Time**: All writes require `request.auth.token.email_verified == true` and `createdAt == request.time` / `updatedAt == request.time` (immutable `createdAt`, `uid`, `userId`, `sessionId`).
5. **No Blanket List or PII Exposure**: Collection `list` queries on `/users/{userId}/savedHospitals`, `/users/{userId}/chatSessions`, and `/messages` evaluate `resource.data.userId == request.auth.uid` directly without `get()`/`exists()` inside `allow list`.

## Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read/write**: `request.auth == null` reading `/users/u1`.
2. **Unverified email write**: `request.auth.token.email_verified == false` writing `/users/u1`.
3. **Cross-user PII read**: `uid == 'u2'` reading `/users/u1` (`email` leak attempt).
4. **Shadow field on user profile create**: `{ uid: 'u1', displayName: 'A', email: 'a@b.com', isAdmin: true, createdAt: serverTime, updatedAt: serverTime }`.
5. **Spoofed timestamp on create**: `{ ..., createdAt: '2020-01-01T00:00:00Z' }` instead of `request.time`.
6. **Privilege escalation via `/admins/{uid}`**: non-admin attempting `set` on `/admins/u2`.
7. **Admin email spoof without verification**: `token.email == 'en23cs301177@medicaps.ac.in'` with `email_verified: false`.
8. **ID Poisoning**: 500-character or `$bad/id` string in `{hospitalKey}` or `{sessionId}`.
9. **Orphaned saved hospital write**: creating `/users/u1/savedHospitals/h1` when `/users/u1` does not exist.
10. **Immutable field mutation**: updating `userId` or `createdAt` on an existing `chatSessions` document.
11. **Oversized message / unbounded array DoW**: `text` with >16,000 chars or `sources` array with 15 items or invalid element map.
12. **Non-atomic message write**: creating `/messages/{m1}` without updating parent `chatSessions/{s1}.updatedAt == request.time`.
