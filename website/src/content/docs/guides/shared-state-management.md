---
title: Shared State Management
description: How to share state and code between apps in τjs
---

How τjs handles shared code and state across multiple applications.

τjs supports sharing code between apps through **build-time composition**. State sharing happens through:

- **Shared code modules** (compiled into each bundle)
- **Persistent storage** (localStorage, cookies, databases)
- **Server-side data** (SSR hydration, API calls)

**Key principle:** Each app runs in its own runtime. There is no shared memory between apps at runtime.

## Shared Code Modules

### Directory Structure

Create a `shared` directory for code used across apps:

```
client/
├── shared/
│   ├── store/              # Shared state stores
│   │   ├── theme.store.ts
│   │   └── user.store.ts
│   ├── components/         # Shared UI components
│   │   ├── Button.tsx
│   │   └── Header.tsx
│   ├── hooks/              # Shared React hooks
│   │   └── useAuth.ts
│   └── utils/              # Shared utilities
│       └── formatting.ts
├── app/                    # Customer app
└── admin/                  # Admin app
```

### Build-Time Compilation

When τjs builds each app:

1. **Shared code is compiled** into each app's bundle
2. **Tree-shaking removes unused exports**
3. **Each app gets its own copy** of the compiled code
4. **No runtime coordination** between apps

**Example:**

```typescript
// shared/store/theme.store.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useThemeStore = create(
  persist(
    (set) => ({
      theme: "light" as "light" | "dark",
      setTheme: (theme: "light" | "dark") => set({ theme }),
    }),
    {
      name: "app-theme", // localStorage key
    }
  )
);
```

```typescript
// client/app/App.tsx
import { useThemeStore } from "@shared/store/theme.store";

export function App() {
  const { theme, setTheme } = useThemeStore();

  return (
    <div className={theme}>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
        Toggle Theme
      </button>
    </div>
  );
}
```

```typescript
// client/admin/App.tsx
import { useThemeStore } from "@shared/store/theme.store";

export function App() {
  const { theme } = useThemeStore();

  return <div className={theme}>Admin content</div>;
}
```

**How it works:**

1. **Build time:** `theme.store.ts` compiled into both bundles
2. **Runtime:** Each app has its own store instance
3. **Persistence:** Both stores read/write same localStorage key
4. **Result:** Theme persists across page navigation between apps

## State Persistence Strategies

### localStorage Persistence

Share state via browser localStorage:

```typescript
// shared/store/preferences.store.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Preferences {
  language: string;
  timezone: string;
  theme: "light" | "dark";
}

export const usePreferencesStore = create(
  persist<Preferences>(
    (set) => ({
      language: "en",
      timezone: "UTC",
      theme: "light",
      setLanguage: (language: string) => set({ language }),
      setTimezone: (timezone: string) => set({ timezone }),
      setTheme: (theme: "light" | "dark") => set({ theme }),
    }),
    {
      name: "user-preferences",
    }
  )
);
```

**Lifecycle:**

```
Customer App                localStorage                 Admin App
────────────                ───────────                 ─────────
User toggles sidebar    →   Update storage          →   (Not yet loaded)
Navigate to admin       →   Read storage            →   Sidebar state restored
```

### Cookie-Based Persistence

For server-accessible state, use cookies:

```typescript
// shared/utils/cookies.ts
export function setCookie(name: string, value: string, days: number = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(
    value
  )}; expires=${expires}; path=/; SameSite=Lax`;
}

export function getCookie(name: string): string | null {
  return (
    document.cookie
      .split("; ")
      .find((row) => row.startsWith(`${name}=`))
      ?.split("=")[1] || null
  );
}
```

```typescript
// shared/store/session.store.ts
import { create } from "zustand";
import { getCookie, setCookie } from "@shared/utils/cookies";

export const useSessionStore = create((set) => ({
  sessionId: getCookie("session_id"),
  setSessionId: (sessionId: string) => {
    setCookie("session_id", sessionId);
    set({ sessionId });
  },
}));
```

### Server-Side State Hydration

Load state from server on each app load:

```typescript
// taujs.config.ts
{
  path: '/app/*',
  attr: {
    render: 'ssr',
    middleware: { auth: {} },
    data: async (params, ctx) => ({
      serviceName: 'UserPreferencesService',
      serviceMethod: 'getPreferences',
      args: { userId: ctx.user.id }
    })
  }
}

{
  path: '/admin/*',
  attr: {
    render: 'ssr',
    middleware: { auth: {} },
    data: async (params, ctx) => ({
      serviceName: 'UserPreferencesService',
      serviceMethod: 'getPreferences',
      args: { userId: ctx.user.id }
    })
  }
}
```

```typescript
// services/user-preferences.service.ts
export const UserPreferencesService = defineService({
  getPreferences: async (params: { userId: string }, ctx) => {
    const prefs = await db.userPreferences.findUnique({
      where: { userId: params.userId },
    });

    return {
      theme: prefs.theme,
      language: prefs.language,
      timezone: prefs.timezone,
    };
  },
});
```

```typescript
// client/app/App.tsx
import { useSSRStore } from "@taujs/react";
import { usePreferencesStore } from "@shared/store/preferences.store";
import { useEffect } from "react";

export function App() {
  const serverData = useSSRStore();
  const { setTheme, setLanguage } = usePreferencesStore();

  // Sync server data to client store
  useEffect(() => {
    if (serverData.theme) setTheme(serverData.theme);
    if (serverData.language) setLanguage(serverData.language);
  }, [serverData]);

  return <div>App content</div>;
}
```

## What to Share

### Good Candidates for Sharing

**UI/UX preferences:**

```typescript
const useThemeStore = create(/* theme state */);
const useLanguageStore = create(/* language state */);
const useLayoutStore = create(/* layout preferences */);
```

**Authentication state:**

```typescript
const useAuthStore = create(/* auth token, user info */);
```

**Feature flags:**

```typescript
const useFeatureFlagsStore = create(/* enabled features */);
```

**Shared UI components:**

```typescript
export { Button, Card, Modal } from "@shared/components";
```

**Utility functions:**

```typescript
export { formatDate, formatCurrency, parseJSON } from "@shared/utils";
```

### Keep Domain-Specific State Isolated

**Customer app state:**

```typescript
// client/app/store/cart.store.ts
const useCartStore = create(/* cart items */);
```

**Admin app state:**

```typescript
// client/admin/store/admin-users.store.ts
const useAdminUsersStore = create(/* admin user list */);
```

**Why:** Domain-specific state doesn't need to persist between apps.

## Testing Shared State

### Unit Testing Stores

```typescript
import { useThemeStore } from "@shared/store/theme.store";

describe("ThemeStore", () => {
  beforeEach(() => {
    // Reset store before each test
    useThemeStore.setState({ theme: "light" });
  });

  it("toggles theme", () => {
    const { setTheme } = useThemeStore.getState();

    setTheme("dark");
    expect(useThemeStore.getState().theme).toBe("dark");

    setTheme("light");
    expect(useThemeStore.getState().theme).toBe("light");
  });
});
```

### Integration Testing Persistence

```typescript
import { usePreferencesStore } from "@shared/store/preferences.store";

describe("Preferences Persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists preferences to localStorage", () => {
    const { setTheme, setLanguage } = usePreferencesStore.getState();

    setTheme("dark");
    setLanguage("es");

    // Verify localStorage
    const stored = JSON.parse(localStorage.getItem("user-preferences") || "{}");

    expect(stored.state.theme).toBe("dark");
    expect(stored.state.language).toBe("es");
  });
});
```

## Best Practices

### 1. Minimise Shared State

Only share what's necessary:

```typescript
// share UI preferences
const useThemeStore = create(/* ... */);

// less ideal - sharing domain logic
const useOrderProcessingStore = create(/* ... */);
```

### 2. Use Appropriate Storage

```typescript
// localStorage for client-only
persist({ name: "ui-preferences" });

// cookies for server-accessible
setCookie("session_id", value);

// database for important data
UserPreferencesService.save(preferences);
```

### 3. Handle Missing Data Gracefully

```typescript
// fallback values
const { theme = "light" } = useThemeStore();

// null checks
const preferences = useSSRStore();
if (preferences.theme) {
  setTheme(preferences.theme);
}
```

### 4. Document Shared State

```typescript
/**
 * Theme store - shared across all apps
 *
 * Persisted to localStorage as 'app-theme'
 * Used by: customer app, admin app, marketing site
 *
 * @example
 * const { theme, setTheme } = useThemeStore();
 */
export const useThemeStore = create(/* ... */);
```

<!--
## What's Next?

- [Dependency Management](/guides/dependency-management) - How shared code is bundled
- [Micro-Frontends](/guides/micro-frontends) - How apps are isolated
- [Build & Deployment](/reference/build-deployment) - Build process details -->
