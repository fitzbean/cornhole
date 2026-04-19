# Online Multiplayer Plan

## The core problem

Today the game runs entirely on one machine: [CornholeGame.ts](src/CornholeGame.ts) owns physics (cannon-es), rendering (three.js), and turn state, and [App.tsx](src/App.tsx) is a thin UI shell. Both "players" share one keyboard.

For online play, two browsers need to see the same game. The big decision is **who runs the physics**, because cannon-es is not deterministic across machines — if both sides simulate independently, bags will land in different spots.

## The architecture: host-authoritative

One player's browser is the **host** and runs the only physics simulation. The other player is the **guest** and just sees snapshots. No game server needed — only a relay for messages.

```
Player A (host)                     Player B (guest)
  CornholeGame (authoritative)        CornholeGame (display-only)
    ├─ runs physics                     ├─ receives state snapshots
    ├─ applies its own inputs           ├─ sends inputs upstream
    └─ broadcasts state ──────────►     └─ renders the received state
                           ▲
                           │
                    ┌──────┴───────┐
                    │ Relay (pick  │
                    │ one below)   │
                    └──────────────┘
```

**Why host-authoritative instead of peer-to-peer lockstep:** cornhole is turn-based with 4 bags per player per round — latency is forgiving and you don't need deterministic sync. Making cannon-es deterministic across browsers is a rabbit hole. Let one side be the source of truth.

**Tradeoff:** if the host drops, the game dies. Fine for MVP. Phase 3 can promote guest to host or move sim server-side.

## Phase 1 — Shareable link, 2 players, no auth

**Goal:** host clicks "Play online", gets a URL, sends it to friend via text/Slack, friend opens it and plays. No login.

### Transport options (pick one)

| Option | Pros | Cons |
|---|---|---|
| **Supabase Realtime broadcast channels** | Free tier, already planned for Phase 2, no extra infra | ~100-200ms relay latency, need anon Supabase project now |
| **PeerJS / WebRTC** | Direct P2P, ~20ms latency, no backend | STUN/TURN complexity, firewalls sometimes block |
| **PartyKit / Cloudflare Durable Objects** | Purpose-built for this, stateful rooms | Another service to manage |

**Recommendation:** Supabase Realtime. You're adopting Supabase in Phase 2 anyway, the latency is fine for a turn-based game, and broadcast channels don't even need tables — just a channel name.

### What to build

1. **Room model** — a room is just a random 6-char code (e.g. `K3X9PQ`). URL is `/?room=K3X9PQ`. Host creates it on "Play online"; guest joins by URL.

2. **Refactor [CornholeGame.ts](src/CornholeGame.ts) to separate input from state** — right now keyboard handlers mutate game state directly inside `setupControls`. Extract an `Intent` layer:
   - `{ type: 'move', dx: number }`
   - `{ type: 'setPower', value: number }`
   - `{ type: 'throw', power: number, angle: number }`
   - `{ type: 'flipBag' }` / `{ type: 'toggleThrowStyle' }`
   - `{ type: 'toggleWeather' }`

   Host applies its own intents locally; guest sends intents over the wire; host receives guest's intents and applies them only when it's guest's turn.

3. **Snapshot broadcasting** — host publishes the full [GameState](src/CornholeGame.ts#L107) after every state change (throttled, maybe 15Hz during flight, on-change otherwise). Guest replaces its local state with whatever host sends. Also broadcast **bag transforms** (positions/quaternions of settled bags) so guest can render them — today these live inside cannon-es bodies, not in GameState, so you'll need to expose them.

4. **Guest render path** — a "slave mode" for `CornholeGame` that skips physics stepping and instead interpolates bag positions from snapshots. Three.js scene and UI stay the same.

5. **Turn gating** — guest's aim/drag/throw controls are only enabled when `gameState.currentPlayer` matches their assigned slot (1 or 2).

6. **Connection UI**:
   - Start screen gets "Play online" button next to "Play"
   - Host sees "Share this link: ..." with copy button, waits for guest
   - Guest joining URL sees "Joining game..." then drops into game
   - Connection loss banner + reconnect

### Files touched

- [src/App.tsx](src/App.tsx) — room UI, URL parsing, guest vs host mode
- [src/CornholeGame.ts](src/CornholeGame.ts) — intent layer, slave mode, snapshot serialization (big refactor around [throwBag()](src/CornholeGame.ts#L1686), [setupControls()](src/CornholeGame.ts#L2761), state mutations)
- **new:** `src/net/` — transport abstraction, intent/snapshot types, Supabase client
- **new:** `src/net/useRoom.ts` — React hook that handles host/guest wiring

### Gotchas

- **Bag physics state isn't in GameState.** Look at [CornholeGame.ts](src/CornholeGame.ts) bag array — you'll need a `serializeBags()` / `applyBagSnapshot()` pair.
- **Weather is randomized.** Host rolls it and broadcasts; guest must not re-roll.
- **Camera.** Each player probably wants their own camera — don't sync camera state, only game state. Cinematic cam stays local.
- **Snapshot size.** Full `GameState` + 8 bag transforms is small (~1–2 KB). Don't worry about delta compression yet.

## Phase 2 — Supabase + Google login + stats

Once Phase 1 works with anonymous sessions, layer in identity and persistence.

### Auth

- Supabase Auth with Google provider
- Anonymous play still allowed (guest can play without logging in) — upgrade to authenticated later
- Login button on start screen; post-login, your name shows on your score card instead of "Player 1/2"

### Schema (Postgres via Supabase)

```sql
profiles          -- one row per authed user
  id uuid pk (= auth.users.id)
  display_name text
  avatar_url text
  created_at timestamptz

matches           -- one row per completed game
  id uuid pk
  host_user_id uuid fk -> profiles (nullable if anon)
  guest_user_id uuid fk -> profiles (nullable if anon)
  host_score int
  guest_score int
  winner_user_id uuid (nullable if anon won)
  innings int
  duration_seconds int
  ended_at timestamptz

match_events      -- optional, for replays/analytics
  id bigserial pk
  match_id uuid fk
  inning int
  player int  -- 1 or 2
  bag_side text
  throw_style text
  points int
  result text  -- 'hole' | 'board' | 'miss'
  weather_snapshot jsonb
  created_at timestamptz

user_stats        -- materialized view or triggered table
  user_id uuid pk
  games_played int
  games_won int
  total_points int
  holes int
  boards int
  avg_ppr numeric
  updated_at timestamptz
```

### RLS policies

- `profiles`: user can read all, update own
- `matches`: user can read matches they participated in; only server/trigger writes
- `user_stats`: public read, trigger-only write

### Stats UI (Phase 2b)

- Profile page at `/profile/:userId` — W/L, PPR, hole rate, recent matches
- Post-game summary screen showing both players' updated stats
- Leaderboard (top PPR, most wins, etc.)

### Files touched

- **new:** `src/auth/` — Supabase auth client, login button, session hook
- **new:** `src/stats/` — profile page, leaderboard, post-game summary
- **new:** `supabase/migrations/` — schema + RLS + triggers
- [src/App.tsx](src/App.tsx) — thread session through, conditionally render login/profile
- Host writes the `matches` + `match_events` rows when [gameOver](src/CornholeGame.ts#L201) flips true

## Phase 3 — Nice-to-haves

- **Reconnect** — persist game state in Supabase so host refresh doesn't kill the match
- **Spectators** — 3rd+ joiner gets read-only view
- **Matchmaking** — quick match against a random online player
- **Server-authoritative physics** — if you ever see cheating or host-disconnect becomes a real problem, move cannon-es to an edge worker (Cloudflare Durable Object / Supabase Edge Function)
- **AI opponent** — single-player mode using the same intent layer

## Recommended order of attack

1. Refactor `CornholeGame` to separate intents from mutations (mergeable today, no networking yet) — **biggest structural change, do first**
2. Add `src/net/` with a local-only mock transport, get 2 tabs on one machine talking via `BroadcastChannel`
3. Swap mock transport for Supabase Realtime
4. Ship Phase 1
5. Add auth + schema
6. Write `matches` on game end, build profile page
7. Ship Phase 2

Step 1 is the only one that touches a lot of existing code. Everything after is additive.
