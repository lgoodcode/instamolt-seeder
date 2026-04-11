---
name: ui-patterns
description: InstaMolt UI and React patterns — text color hierarchy, tooltip usage, navigation patterns, JSX performance rules, component conventions. Load when working on React components, layouts, pages, or UI in src/app/ or src/components/.
---

# UI & React Patterns

## Text Color Hierarchy

Use Instamolt's semantic utilities for all text color in app components:

| Utility            | Purpose                | Example                           |
| ------------------ | ---------------------- | --------------------------------- |
| `text-foreground`  | Primary text (default) | Headings, usernames, body         |
| `text-copy`        | Body text              | Paragraphs, descriptions          |
| `text-copy-subtle` | Secondary labels       | Stat labels, timestamps, metadata |
| `text-copy-faint`  | Tertiary / very faint  | Disclaimers, copyright, hints     |

**NEVER use `text-muted-foreground`** in app components — it's reserved for shadcn primitives in `src/components/ui/`.

## Tooltips

**NEVER use HTML `title` attributes** for tooltips. Use the `<Tooltip>` component:

```tsx
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

<TooltipProvider delayDuration={200}>
  <Tooltip>
    <TooltipTrigger>{children}</TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
</TooltipProvider>;
```

Wrap with `<TooltipProvider delayDuration={200}>` per component.

## Buttons

- **Always use the shared `<Button>`** from `@/components/ui/button` — never raw `<button>` elements
- The shared component provides focus-visible ring, disabled state, hover transitions, and consistent sizing
- Use the appropriate `variant`: `default`, `ghost`, `outline`, `secondary`, `destructive`, `link`
- For custom sizing, override with `h-auto` + padding utilities (e.g., `className="h-auto px-2 py-1"`)
- shadcn primitives in `src/components/ui/` may use raw `<button>` internally — that's fine

```tsx
// Correct — shared component with focus ring, hover, disabled
<Button variant="ghost" onClick={onClick} className="h-auto gap-1.5 px-2 py-1">
  {content}
</Button>

// Wrong — no focus ring, inconsistent hover, no disabled styling
<button type="button" onClick={onClick} className="rounded-md px-2 py-1 hover:bg-muted">
  {content}
</button>
```

## Navigation

- **Internal routes**: Use `next/link` `<Link>` — never raw `<a>` tags
- **External links, API redirects, anchors, file downloads**: Raw `<a>` is fine
- **Programmatic navigation**: `useRouter` from `next/navigation` (NEVER from `next/router`)

### Button asChild + Navigation

When wrapping links in `<Button asChild>`, the same `<Link>` vs `<a>` rules apply. ESLint does **not** catch `<a>` inside component wrappers — `pnpm check:links` enforces this.

```tsx
// Internal route → <Link>
<Button asChild><Link href="/docs">API Docs</Link></Button>

// Static file download → <a>
<Button asChild><a href="/skill.md">Download</a></Button>

// API redirect (OAuth) → <a>
<Button asChild><a href="/api/v1/auth/x/start">Sign in</a></Button>
```

### Post Modal Navigation (pushState)

Post modals use `pushState`/`popstate` to update the URL without triggering Next.js page navigation. This allows the browser back button to close the modal instead of leaving the page.

**Hook**: `usePostModal(basePath)` from `@/hooks/use-post-modal`

```tsx
const { selectedPostId, openModal, closeModal } = usePostModal("/feed");

// Open: pushes {basePath}/{postId} onto history
<PostCard post={post} onPostClick={openModal} />;

// Render modal when open
{
  selectedPostId && <PostModal postId={selectedPostId} onClose={closeModal} />;
}
```

**URL patterns** (managed by pushState, not actual routes):

- `/feed/{uuid}` — modal on feed page
- `/explore/{uuid}` — modal on explore page
- `/agent/{name}/{uuid}` — modal on agent profile page

**Hard refresh handling**: `next.config.mjs` has `afterFiles` rewrites that map these URLs back to their base pages. The hook detects the UUID in `usePathname()` on mount and auto-opens the modal.

**Progress bar**: `use-navigation-progress.tsx` skips the progress bar for modal navigation via `isModalNavigation()` — compares two pathnames after stripping UUID suffixes.

**Internal links inside the modal** (agent names, hashtags): Do NOT call `onClose()` — navigation away naturally closes the modal via the `usePathname()` effect. The `onClose` prop is only used by X button, backdrop click, Escape key, and mobile gestures.

## Page Metadata Pattern

Every page must export `metadata` (static) or `generateMetadata()` (dynamic params). Client-heavy pages use a **server/client split**:

- `page.tsx` — thin server component that exports metadata and renders the client component
- `*-client.tsx` — `'use client'` component with all UI logic

Examples:

- `src/app/(main)/page.tsx` → `landing-client.tsx`
- `src/app/(main)/feed/page.tsx` → `feed-client.tsx`
- `src/app/(main)/explore/page.tsx` → `explore-client.tsx`

Dynamic pages use `generateMetadata()` with awaited `params`:

- `src/app/(main)/agent/[agentname]/page.tsx` — `@${agentname}` in title
- `src/app/(main)/dashboard/[agentName]/page.tsx` — `@${agentName} - Dashboard`

Title uses root template: `'%s | InstaMolt'` (set in `src/app/layout.tsx`).

## JSX Performance

- **NEVER create inline objects/arrays in JSX** (e.g., `style={{ ... }}`, inline `{}` props). They create new references every render, causing unnecessary re-renders and GC pressure
- Use `useMemo`, constants, or CSS classes instead
- Extract static objects/arrays to module-level constants
- For dynamic style props (e.g., progress bar widths), memoize the style object:

```tsx
// Wrong — new object every render
<div style={{ width: `${percent}%` }} />;

// Correct — stable reference
const barStyle = useMemo(() => ({ width: `${percent}%` }), [percent]);
<div style={barStyle} />;
```

## Browser APIs

- **Use `globalThis` instead of `window`** — enforced by `unicorn/prefer-global-this`. Applies to `new globalThis.Image()`, `globalThis.addEventListener(...)`, etc.
- **Use `addEventListener`/`removeEventListener`** — never assign `onX` handler properties (e.g., `img.onload = fn`). Enforced by `unicorn/prefer-add-event-listener`. Always use a shared function reference so the listener can be properly removed in cleanup:

```tsx
// Correct
const onLoad = () => setState("full");
img.addEventListener("load", onLoad);
return () => img.removeEventListener("load", onLoad);

// Wrong — onX assignment
img.onload = () => setState("full");
img.onload = null; // cleanup
```
