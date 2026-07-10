---
title: Dependency Management
description: How τjs resolves and optimises dependencies across applications
---

How τjs resolves and optimises dependencies across multiple applications.

## Overview

τjs uses a **single dependency tree** at the project root. Vite's tree-shaking removes unused code from each bundle at build time. This means:

- One `node_modules` directory at project root
- Each app declares its dependencies in its own `package.json`
- Dependencies are hoisted to root by package manager
- Each app bundle only includes what it imports

**Key insight:** The sise of `node_modules` doesn't affect bundle sise. Only imports determine what's included in each bundle.

## How It Works

### Dependency Resolution

```
project/
├── package.json              # Root package.json with workspaces
├── node_modules/             # Single dependency tree (hoisted)
│   ├── react/
│   ├── react-dom/
│   ├── @tanstack/react-query/
│   ├── zustand/
│   └── ...
│
└── client/
    ├── app/
    │   └── package.json      # Declares: react, react-query
    └── admin/
        └── package.json      # Declares: react, zustand
```

### Build-Time Tree-Shaking

When τjs builds each app:

1. **Vite analses imports** in app code
2. **Only includes imported modules** in bundle
3. **Shared dependencies optimised** automatically
4. **Unused code removed** from final bundle

**Example:**

```
Customer App Build:
─────────────────────────────────────────
Scans imports in client/app/
- import React from 'react'                    ✓ Included
- import { useQuery } from '@tanstack/react-query'  ✓ Included
- (zustand never imported)                     ✗ Excluded

Bundle: React + react-query
Size: 1.6MB

Admin App Build:
─────────────────────────────────────────
Scans imports in client/admin/
- import React from 'react'                    ✓ Included
- import { create } from 'zustand'             ✓ Included
- (@tanstack/react-query never imported)      ✗ Excluded

Bundle: React + zustand
Size: 1.3MB
```

**Result:** Each app only ships code it actually uses.

## Workspace Setup

### Using npm Workspaces

```json
// package.json (root)
{
  "name": "my-project",
  "workspaces": ["client/*"],
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

```json
// client/app/package.json
{
  "name": "@my-project/app",
  "dependencies": {
    "@tanstack/react-query": "^5.0.0"
  }
}
```

```json
// client/admin/package.json
{
  "name": "@my-project/admin",
  "dependencies": {
    "zustand": "^4.0.0"
  }
}
```

**Installation:**

```bash
# Install all dependencies
npm install

# Install app-specific dependency
cd client/app
npm install @tanstack/react-query

# Install admin-specific dependency
cd client/admin
npm install zustand
```

**How it works:**

- npm hoists dependencies to root `node_modules`
- Each app's `package.json` declares what it needs
- Workspace manager links packages together
- Build time: Vite resolves from root `node_modules`

### Workspace Managers

τjs works with any workspace manager:

**npm workspaces** (built-in to npm 7+):

```json
{
  "workspaces": ["client/*"]
}
```

**pnpm workspaces**:

```yaml
# pnpm-workspace.yaml
packages:
  - "client/*"
```

**Yarn workspaces**:

```json
{
  "workspaces": ["client/*"],
  "packageManager": "yarn@4.0.0"
}
```

**All achieve the same goal:** Single dependency tree, per-app declarations.

## Practical Workflow

### Root Dependencies (Shared)

Install dependencies used by all apps at root:

```bash
# At project root
npm install react react-dom
```

```json
// package.json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

### App-Specific Dependencies

Install dependencies used by specific apps:

```bash
# Customer app needs react-query
cd client/app
npm install @tanstack/react-query

# Admin app needs zustand
cd client/admin
npm install zustand

# Both are hoisted to root node_modules
```

**Result:**

```
node_modules/
├── react/                    # Used by both
├── react-dom/                # Used by both
├── @tanstack/react-query/    # Only bundled in customer app
└── zustand/                  # Only bundled in admin app
```

## Shared Code Between Apps

### Shared Directory

Create a shared directory for code used across apps:

```
client/
├── shared/
│   ├── components/
│   │   ├── Button.tsx
│   │   └── Card.tsx
│   ├── hooks/
│   │   └── useAuth.ts
│   └── utils/
│       └── formatting.ts
├── app/
└── admin/
```

### Path Aliases

Configure aliases to import shared code:

```typescript
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["./client/shared/*"],
      "@app/*": ["./client/app/*"],
      "@admin/*": ["./client/admin/*"]
    }
  }
}
```

τjs automatically resolves these during build.

### Using Shared Code

```typescript
// client/app/features/Dashboard.tsx
import { Button } from "@shared/components/Button";
import { useAuth } from "@shared/hooks/useAuth";
import { formatDate } from "@shared/utils/formatting";

export function Dashboard() {
  const { user } = useAuth();

  return (
    <div>
      <h1>Welcome, {user.name}</h1>
      <Button>Click me</Button>
      <p>Joined: {formatDate(user.createdAt)}</p>
    </div>
  );
}
```

```typescript
// client/admin/features/UserList.tsx
import { Button } from "@shared/components/Button"; // Same component
import { formatDate } from "@shared/utils/formatting";

export function UserList({ users }) {
  return (
    <div>
      {users.map((user) => (
        <div key={user.id}>
          <span>{formatDate(user.createdAt)}</span>
          <Button>Edit</Button>
        </div>
      ))}
    </div>
  );
}
```

**Build behavior:**

- `Button.tsx` compiled once by Vite
- Included in both app bundles
- Optimised automatically
- No duplication of compiled code

## Dependency Version Management

### Shared Major Versions

Apps should coordinate on major versions of shared dependencies:

```json
// Root package.json
{
  "dependencies": {
    "react": "^19.0.0", // All apps use React 19
    "react-dom": "^19.0.0"
  }
}
```

**Why:** Different React versions can cause runtime issues.

### Independent Library Versions

Apps can use different versions of independent libraries:

```json
// client/app/package.json
{
  "dependencies": {
    "@tanstack/react-query": "^5.0.0"
  }
}
```

```json
// client/admin/package.json
{
  "dependencies": {
    "@tanstack/react-query": "^4.0.0" // Different version OK
  }
}
```

Package managers handle version resolution - each app gets the version it needs.

## Common Scenarios

### Adding a New Dependency

**To all apps:**

```bash
# At root
npm install lodash

# All apps can now import lodash
```

**To specific app:**

```bash
# In app directory
cd client/app
npm install date-fns

# Only customer app can import date-fns
# Only customer bundle includes it
```

### Upgrading a Shared Dependency

```bash
# At root
npm install react@latest react-dom@latest

# All apps now use updated React
# Rebuild to pick up changes
npm run build
```

### Removing a Dependency

```bash
# Remove from app package.json
cd client/app
npm uninstall @tanstack/react-query

# Clean install
cd ../..
npm install

# Rebuild
npm run build
```

## Best Practices

### 1. Declare Dependencies Explicitly

```json
// app declares what it needs
{
  "dependencies": {
    "@tanstack/react-query": "^5.0.0",
    "date-fns": "^2.0.0"
  }
}

// less ideal - relying on hoisted dependency without declaration
// (might break if other app removes it)
```

### 2. Keep Shared Dependencies at Root

```json
// shared by all apps
// Root package.json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

### 3. Regular Dependency Audits

```bash
# Check for outdated dependencies
npm outdated

# Check for security issues
npm audit

# Update dependencies
npm update
```

### 4. Lock File Discipline

```bash
# Commit lock file
git add package-lock.json

# Don't commit node_modules
echo "node_modules" >> .gitignore
```

<!--
## What's Next?

- [Shared State](/guides/shared-state-management) - Share state between apps
- [Build & Deployment](/reference/build-deployment) - Full build process details
- [Micro-Frontends](/guides/micro-frontends) - How apps work together -->
