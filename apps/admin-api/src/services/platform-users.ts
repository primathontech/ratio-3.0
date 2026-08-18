import { createClerkClient } from '@clerk/backend';
import { listAllUsers, type PlatformUserRow } from '../middleware/auth';

// A memberships-derived user enriched with their Clerk profile (name/email). name/email are null
// when Clerk isn't configured or has no profile for them.
export interface PlatformUser extends PlatformUserRow {
  name: string | null;
  email: string | null;
}

// The bit of a Clerk profile the console surfaces. createdAt is the sign-up time (ms).
export interface ClerkProfile {
  userId: string;
  name: string | null;
  email: string | null;
  createdAt: number;
}

// Every Clerk user's profile. Returns [] when Clerk isn't configured (CLERK_SECRET_KEY absent) or the
// call fails — the users view then degrades to memberships-only data. Single page (staging scale);
// revisit pagination for production.
export async function fetchClerkProfiles(): Promise<ClerkProfile[]> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return [];
  try {
    const clerk = createClerkClient({ secretKey });
    const { data } = await clerk.users.getUserList({ limit: 500 });
    return data.map((u) => {
      const primary =
        u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || null;
      return { userId: u.id, name, email: primary?.emailAddress ?? null, createdAt: u.createdAt };
    });
  } catch (e) {
    console.warn(
      '[admin-api] Clerk user fetch failed; users view degrades to memberships only:',
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

const toIso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

// Merge memberships-derived users with Clerk profiles: enrich known users with name/email, and add
// Clerk users who have no store yet as zero-store rows. Pure — the composition root injects both.
export function mergePlatformUsers(
  dbUsers: PlatformUserRow[],
  profiles: ClerkProfile[]
): PlatformUser[] {
  const profileById = new Map(profiles.map((p) => [p.userId, p]));
  const byId = new Map<string, PlatformUser>();
  for (const u of dbUsers) {
    const p = profileById.get(u.userId);
    byId.set(u.userId, {
      ...u,
      joined: toIso(u.joined),
      name: p?.name ?? null,
      email: p?.email ?? null,
    });
  }
  for (const p of profiles) {
    if (byId.has(p.userId)) continue;
    byId.set(p.userId, {
      userId: p.userId,
      storeCount: 0,
      joined: new Date(p.createdAt).toISOString(),
      stores: [],
      name: p.name,
      email: p.email,
    });
  }
  // Store owners first (by store count desc), then earliest joined; zero-store sign-ups fall to the
  // bottom (count 0) and among themselves sort by sign-up date.
  return [...byId.values()].sort((a, b) =>
    b.storeCount !== a.storeCount ? b.storeCount - a.storeCount : a.joined.localeCompare(b.joined)
  );
}

export async function listPlatformUsers(): Promise<PlatformUser[]> {
  const [dbUsers, profiles] = await Promise.all([listAllUsers(), fetchClerkProfiles()]);
  return mergePlatformUsers(dbUsers, profiles);
}
