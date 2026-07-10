---
title: Content Security Policy
description: How τjs generates and manages CSP headers
---

How τjs generates and manages CSP headers for your routes.

## Overview

τjs provides CSP middleware that generates nonce-based Content Security Policy headers and exposes the nonce to your rendering pipeline. This allows inline scripts to execute safely while blocking unauthorised code.

## Basic Configuration

Configure CSP globally in your τjs config:

```typescript
// taujs.config.ts
export default defineConfig({
  security: {
    csp: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
      },
    },
  },
});
```

τjs automatically:

1. Generates a unique nonce per request
2. Adds `'nonce-<value>'` to `script-src` if not present
3. Applies the header to all responses
4. Passes nonce to React's rendering pipeline

## How It Works

### Nonce Generation

For each request, τjs:

```typescript
// Internal - τjs does this automatically
const nonce = crypto.randomBytes(16).toString('base64');

// Adds to script-src
'script-src': ["'self'", "'nonce-abc123...'"]

// Sets header
Content-Security-Policy: script-src 'self' 'nonce-abc123...'

// Passes to renderer
renderStream(res, callbacks, data, location, modules, meta, nonce);
```

### Automatic Application

The nonce is automatically applied to:

- React's `renderToPipeableStream` (via nonce option)
- `window.__INITIAL_DATA__` script
- Client bootstrap script

**You do not add nonces manually** - τjs handles this.

## Development vs Production

### Development Mode

τjs automatically relaxes CSP for development:

```typescript
// Your config
{
  directives: {
    'script-src': ["'self'"],
    'style-src': ["'self'"]
  }
}

// τjs adds in development
{
  'script-src': ["'self'", "'nonce-...'"],
  'connect-src': ["'self'", 'ws:', 'http:'],  // For Vite/HMR
  'style-src': ["'self'", "'unsafe-inline'"]  // For hot styles
}
```

### Production Mode

In production, only your directives plus nonce are used:

```typescript
// Your config
{
  'script-src': ["'self'"],
  'style-src': ["'self'"]
}

// Result in production
{
  'script-src': ["'self'", "'nonce-...'"],
  'style-src': ["'self'"]
}
```

If you ship with development-style directives, τjs logs a warning.

## Per-Route CSP

Override or extend CSP for specific routes:

### Merge Mode (Default)

Route directives are merged with global directives:

```typescript
// Global config
security: {
  csp: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"]
    }
  }
}

// Route config
{
  path: '/embed',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        directives: {
          'frame-ancestors': ["'self'", 'https://trusted.com']
        }
      }
    }
  }
}

// Result for /embed
{
  'default-src': ["'self'"],
  'script-src': ["'self'", "'nonce-...'"],
  'frame-ancestors': ["'self'", 'https://trusted.com']
}
```

### Replace Mode

Replace global directives entirely:

```typescript
{
  path: '/widget',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        mode: 'replace',
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://cdn.example.com'],
          'style-src': ["'self'", "'unsafe-inline'"]
        }
      }
    }
  }
}
```

## Dynamic CSP

Generate directives based on request parameters:

```typescript
{
  path: '/user/:id',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        directives: ({ params, headers }) => ({
          'img-src': [
            "'self'",
            `https://cdn.example.com/users/${params.id}/`
          ],
          'connect-src': ["'self'", 'https://api.example.com']
        })
      }
    }
  }
}
```

**Function receives:**

- `params` - Route parameters
- `headers` - Request headers

## Disabling CSP

### Hard Disable (No Header)

```typescript
{
  path: '/legacy',
  attr: {
    render: 'ssr',
    middleware: {
      csp: false  // No CSP header at all
    }
  }
}
```

Use when:

- Legacy HTML that can't work with CSP
- Third-party widgets with inline scripts

### Soft Disable (Keep Global)

```typescript
{
  path: '/report',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        disabled: true  // Skip route overrides, use global only
      }
    }
  }
}
```

## Report-Only Mode

Test CSP without blocking:

### Global Report-Only

```typescript
export default defineConfig({
  security: {
    csp: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
      },
      reporting: {
        reportOnly: true,
      },
    },
  },
});
```

Header sent: `Content-Security-Policy-Report-Only`

### Per-Route Report-Only

```typescript
{
  path: '/experimental',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        reportOnly: true,
        directives: {
          'script-src': ["'self'", "'strict-dynamic'"]
        }
      }
    }
  }
}
```

## Violation Reporting

### Configure Reporting Endpoint

```typescript
export default defineConfig({
  security: {
    csp: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
      },
      reporting: {
        endpoint: "/api/csp-violations",
        onViolation: (report, req) => {
          console.log("CSP violation:", {
            documentUri: report["document-uri"],
            violatedDirective: report["violated-directive"],
            blockedUri: report["blocked-uri"],
          });
        },
      },
    },
  },
});
```

### Custom Violation Handler

```typescript
reporting: {
  endpoint: '/api/csp-violations',
  onViolation: (report, req) => {
    const violation = report['csp-report'];

    // Log to monitoring service
    logger.warn({
      event: 'csp_violation',
      documentUri: violation['document-uri'],
      directive: violation['violated-directive'],
      blockedUri: violation['blocked-uri'],
      userAgent: req.headers['user-agent']
    });

    // Alert on specific violations
    if (violation['blocked-uri'].includes('malicious')) {
      alertSecurityTeam(violation);
    }
  }
}
```

## Common Patterns

### Allowing CDN Assets

```typescript
security: {
  csp: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://cdn.example.com'],
      'img-src': ["'self'", 'https://cdn.example.com', 'data:'],
      'font-src': ["'self'", 'https://cdn.example.com']
    }
  }
}
```

### Analytics and Tracking

```typescript
security: {
  csp: {
    directives: {
      'default-src': ["'self'"],
      'script-src': [
        "'self'",
        'https://www.google-analytics.com',
        'https://www.googletagmanager.com'
      ],
      'connect-src': [
        "'self'",
        'https://www.google-analytics.com',
        'https://analytics.google.com'
      ],
      'img-src': [
        "'self'",
        'https://www.google-analytics.com',
        'data:'
      ]
    }
  }
}
```

### Embedded Content

```typescript
{
  path: '/embed',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        directives: {
          'frame-src': ["'self'", 'https://www.youtube.com'],
          'frame-ancestors': ["'self'", 'https://trusted-partner.com']
        }
      }
    }
  }
}
```

## Best Practices

### 1. Start Strict, Relax as Needed

```typescript
// Start here
directives: {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'"]
}

// Add sources only when needed
```

### 2. Avoid 'unsafe-inline' in Production

```typescript
// Defeats CSP purpose
'script-src': ["'self'", "'unsafe-inline'"]

// Use nonces (τjs does this automatically)
'script-src': ["'self'", "'nonce-...'"]
```

### 3. Be Specific with Sources

```typescript
// Too broad
'script-src': ["'self'", 'https:']

// Specific domains
'script-src': ["'self'", 'https://cdn.example.com', 'https://analytics.google.com']
```

### 4. Monitor Violations

```typescript
reporting: {
  endpoint: '/api/csp-violations',
  onViolation: (report, req) => {
    monitoringService.track('csp_violation', {
      directive: report['violated-directive'],
      blockedUri: report['blocked-uri'],
      page: report['document-uri']
    });
  }
}
```

### 5. Test Before Enforcing

Use report-only mode initially:

```typescript
security: {
  csp: {
    directives: { /* ... */ },
    reporting: {
      reportOnly: true  // Monitor without blocking
    }
  }
}
```

After confirming no false positives, switch to enforce mode.

<!--
## What's Next?

- [Logging & Telemetry](/guides/logging-telemetry) - Log CSP violations
- [Authentication](/guides/authentication) - Secure your routes
- [Static Assets](/guides/static-assets) - Serve assets with CSP -->
